import type {
  ChiHandoff,
  ChiMentionOperation,
  ChiMentionResult,
  ChiMentionContext,
} from "@getpaseo/protocol/chi-mentions";
import {
  ChiMentionOperationSchema,
  ChiMentionContextSchema,
  ChiOperationError,
} from "@getpaseo/protocol/chi-mentions";
import { z } from "zod";
import { sameMentionContext } from "./mention-context";
import type { ContinuationStorage } from "./continuation-state";
import { withOperationStorage } from "./operation-storage";

const envelopeSchema = z.object({
  context: ChiMentionContextSchema,
  operation: ChiMentionOperationSchema,
  rejected: z.boolean().optional(),
  attempt: z.string().uuid().optional(),
});

export interface ReplyState {
  text: string;
  status: "loading" | "editing" | "pending" | "failed" | "sent" | "blocked";
  error: string | null;
  operation: ChiMentionOperation | null;
  canDiscard: boolean;
  canReauthorize: boolean;
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
  let state: ReplyState = {
    text: "",
    status: "loading",
    error: null,
    operation: null,
    canDiscard: false,
    canReauthorize: false,
  };
  const exclusive = <T>(run: () => Promise<T>) =>
    withOperationStorage(input.storage, input.key, run);
  async function read() {
    const saved = await input.storage.getItem(input.key);
    return saved ? envelopeSchema.parse(JSON.parse(saved)) : null;
  }
  async function complete(operation: ChiMentionOperation) {
    await exclusive(async () => {
      const saved = await read();
      if (saved && JSON.stringify(saved.operation) === JSON.stringify(operation))
        await input.storage.removeItem(input.key);
    });
  }
  let closed = false;
  const listeners = new Set<() => void>();
  function publish(patch: Partial<ReplyState>) {
    if (closed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  const ready = exclusive(async () => {
    const envelope = await read();
    if (!envelope) {
      publish({ status: "editing" });
      return;
    }
    const op = envelope.operation;
    if (op.action !== "reply" && op.action !== "acknowledge")
      throw new Error("Invalid saved mention operation");
    if (op.id !== input.handoff.id) throw new Error("Invalid saved mention operation");
    if (!sameMentionContext(envelope.context, input.context)) {
      publish({
        status: "blocked",
        error: "chi-mention-context-changed",
        canReauthorize:
          envelope.context.actor === input.context.actor &&
          envelope.context.deployment === input.context.deployment &&
          envelope.context.repo === input.context.repo,
      });
      return;
    }
    const applied = input.handoff.replies?.some((reply) => reply.id === op.operationId);
    if (applied) {
      // The entire restore/check/remove runs in the same lane as prepare and completion.
      await input.storage.removeItem(input.key).catch(() => undefined);
      publish({ status: "sent" });
      return;
    }
    publish({
      operation: op,
      text: op.action === "reply" ? op.text : "",
      status: "failed",
      canDiscard: envelope.rejected === true,
      error: envelope.rejected
        ? "chi-reply-rejected"
        : "Delivery unconfirmed. Retry the saved operation.",
    });
    return;
  }).catch(() =>
    publish({
      status: "blocked",
      error: "Unable to restore the pending reply. Refresh and try again.",
    }),
  );
  async function send(action: "reply" | "acknowledge") {
    await ready;
    if (closed || state.status === "pending" || state.status === "blocked") return;
    if (!state.operation && action === "reply" && state.text.trim().length > 8000) {
      publish({ status: "failed", error: "chi-mention-text-too-long" });
      return;
    }
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
    let attempt: string | undefined;
    try {
      ChiMentionOperationSchema.parse(operation);
      await exclusive(async () => {
        const saved = await read();
        if (
          saved &&
          (!sameMentionContext(saved.context, input.context) ||
            JSON.stringify(saved.operation) !== JSON.stringify(operation))
        )
          throw new Error("chi-mention-submission-unresolved");
        attempt = crypto.randomUUID();
        await input.storage.setItem(
          input.key,
          JSON.stringify({ context: input.context, operation, attempt }),
        );
      });
      const result = await input.execute(operation);
      if (result.kind !== "handoff") throw new Error("Unexpected mention response");
      await complete(operation).catch(() => undefined);
      publish({ status: "sent", text: "", operation: null });
      if (!closed) input.onSuccess(result.handoff);
    } catch (error) {
      const notCommitted =
        error instanceof ChiOperationError && error.failure?.outcome === "not_committed";
      let rejected = false;
      if (notCommitted && attempt !== undefined)
        rejected = await exclusive(async () => {
          const saved = await read();
          if (
            saved &&
            saved.attempt === attempt &&
            JSON.stringify(saved.operation) === JSON.stringify(operation)
          ) {
            await input.storage.setItem(input.key, JSON.stringify({ ...saved, rejected: true }));
            return true;
          }
          return false;
        }).catch(() => false);
      publish({
        status: "failed",
        canDiscard: rejected,
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
      if (!state.canDiscard || !state.operation || closed) return false;
      try {
        const operation = state.operation;
        const discarded = await exclusive(async () => {
          const saved = await read();
          if (!saved?.rejected || JSON.stringify(saved.operation) !== JSON.stringify(operation))
            return false;
          await input.storage.removeItem(input.key);
          return true;
        });
        if (!discarded) {
          publish({ canDiscard: false, error: "chi-mention-submission-unresolved" });
          return false;
        }
        publish({ operation: null, status: "editing", error: null, canDiscard: false });
        return true;
      } catch {
        publish({ error: "chi-reply-storage-unavailable" });
        return false;
      }
    },
    async reauthorize() {
      await ready;
      if (!state.canReauthorize || closed) return;
      await exclusive(async () => {
        const saved = await read();
        if (
          !saved ||
          saved.context.actor !== input.context.actor ||
          saved.context.repo !== input.context.repo ||
          saved.context.deployment !== input.context.deployment
        )
          throw new Error("chi-mention-context-changed");
        await input.storage.setItem(
          input.key,
          JSON.stringify({ ...saved, context: input.context, attempt: crypto.randomUUID() }),
        );
        publish({
          status: "failed",
          operation: saved.operation,
          text: saved.operation.action === "reply" ? saved.operation.text : "",
          canReauthorize: false,
          canDiscard: saved.rejected === true,
          error: "Delivery unconfirmed. Retry the saved operation.",
        });
      }).catch(() => publish({ error: "chi-reply-storage-unavailable" }));
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}
