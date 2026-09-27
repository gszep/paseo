import type {
  ChiHandoff,
  ChiMentionOperation,
  ChiMentionResult,
  ChiMentionContext,
} from "@getpaseo/protocol/chi-mentions";
import {
  ChiMentionOperationSchema,
  ChiMentionContextSchema,
} from "@getpaseo/protocol/chi-mentions";
import { z } from "zod";
import { sameMentionContext } from "./mention-context";
import type { ContinuationStorage } from "./continuation-state";

export interface ReplyState {
  text: string;
  status: "loading" | "editing" | "pending" | "failed" | "sent" | "blocked";
  error: string | null;
  operation: ChiMentionOperation | null;
}
export function openReplyForm(input: {
  handoff: ChiHandoff;
  context: ChiMentionContext;
  key: string;
  storage: ContinuationStorage;
  execute(operation: ChiMentionOperation): Promise<ChiMentionResult>;
  onSuccess(handoff: ChiHandoff): void;
  uuid(): string;
}) {
  let state: ReplyState = { text: "", status: "loading", error: null, operation: null };
  let closed = false;
  const listeners = new Set<() => void>();
  function publish(patch: Partial<ReplyState>) {
    if (closed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  const ready = input.storage
    .getItem(input.key)
    .then(async (saved) => {
      if (!saved) {
        publish({ status: "editing" });
        return;
      }
      const envelope = z
        .object({ context: ChiMentionContextSchema, operation: ChiMentionOperationSchema })
        .parse(JSON.parse(saved));
      if (!sameMentionContext(envelope.context, input.context))
        throw new Error("chi-mention-context-changed");
      const op = envelope.operation;
      if (op.action !== "reply" && op.action !== "acknowledge")
        throw new Error("Invalid saved mention operation");
      if (op.id !== input.handoff.id) throw new Error("Invalid saved mention operation");
      const applied = input.handoff.replies?.some((reply) => reply.id === op.operationId);
      if (applied) {
        await input.storage.removeItem(input.key).catch(() => undefined);
        publish({ status: "sent" });
        return;
      }
      publish({
        operation: op,
        text: op.action === "reply" ? op.text : "",
        status: "failed",
        error: "Delivery unconfirmed. Retry the saved operation.",
      });
      return;
    })
    .catch(() =>
      publish({
        status: "blocked",
        error: "Unable to restore the pending reply. Refresh and try again.",
      }),
    );
  async function send(action: "reply" | "acknowledge") {
    await ready;
    if (closed || state.status === "pending" || state.status === "blocked") return;
    const operation =
      state.operation ??
      (action === "reply"
        ? {
            action,
            id: input.handoff.id,
            operationId: input.uuid(),
            revision: input.handoff.revision,
            text: state.text.trim(),
          }
        : {
            action,
            id: input.handoff.id,
            operationId: input.uuid(),
            revision: input.handoff.revision,
          });
    if (operation.action === "reply" && !operation.text) return;
    publish({ status: "pending", error: null, operation });
    try {
      await input.storage.setItem(input.key, JSON.stringify({ context: input.context, operation }));
      const result = await input.execute(operation);
      if (result.kind !== "handoff") throw new Error("Unexpected mention response");
      await input.storage.removeItem(input.key).catch(() => undefined);
      publish({ status: "sent", text: "", operation: null });
      if (!closed) input.onSuccess(result.handoff);
    } catch (error) {
      publish({
        status: "failed",
        error: error instanceof Error ? error.message : "Unable to send reply",
      });
    }
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setText(text: string) {
      if (!state.operation && state.status !== "blocked")
        publish({ text, status: "editing", error: null });
    },
    send,
    async discardConflict() {
      if (state.error !== "chi-mentions-http-409") return;
      await input.storage.removeItem(input.key);
      publish({ operation: null, status: "editing", error: null });
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}
