import {
  CoDriveRequestSchema,
  CoDriveViewSchema,
  type CoDriveRequest,
  type CoDriveView,
  type ChiEntryRef,
  type ChiMentionContext,
  type ChiMentionOperation,
  type ChiMentionResult,
} from "@getpaseo/protocol/chi-mentions";
import { sameMentionContext } from "./mention-context";
import { withOperationStorage } from "./operation-storage";
import type { ContinuationStorage } from "./continuation-state";
import { z } from "zod";
import { Buffer } from "buffer";
import { ChiMentionContextSchema } from "@getpaseo/protocol/chi-mentions";

const savedSchema = z
  .object({ context: ChiMentionContextSchema, request: CoDriveRequestSchema })
  .strict();
interface State {
  phase: "loading" | "ready" | "pending" | "failed" | "blocked";
  view: CoDriveView | null;
  text: string;
  recipient: string;
  draft: number;
  error: string | null;
  pending: CoDriveRequest | null;
}
const samePin = (a: ChiEntryRef["pin"], b: ChiEntryRef["pin"]) =>
  a.sourceId === b.sourceId &&
  a.repo === b.repo &&
  a.deployment === b.deployment &&
  a.head === b.head &&
  a.count === b.count;

/** A saved send is immutable across retry/reload. Polling only reads status;
 * neither opening nor receipt recovery automatically submits another prompt. */
export function openCoDrive(input: {
  context: ChiMentionContext;
  source: ChiEntryRef;
  pin: ChiEntryRef["pin"];
  storage: ContinuationStorage;
  isCurrent(): boolean;
  execute(operation: ChiMentionOperation): Promise<ChiMentionResult>;
  uuid(): string;
}) {
  const key = `chi-control:${JSON.stringify([input.context.deployment, input.context.actor, input.source.pin.repo, input.source.pin.sourceId])}`;
  let state: State = {
    phase: "loading",
    view: null,
    text: "",
    recipient: "",
    draft: 0,
    error: null,
    pending: null,
  };
  let selected = { ...input.pin },
    closed = false,
    timer: ReturnType<typeof setTimeout> | null = null,
    reading = false;
  const listeners = new Set<() => void>();
  let responseEpoch = 0;
  const publish = (patch: Partial<State>) => {
    if (!closed) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    }
  };
  const current = () => {
    if (closed || !input.isCurrent()) throw new Error("chi-mention-context-changed");
  };
  const execute = async (request: CoDriveRequest) => {
    current();
    const epoch = responseEpoch;
    const result = await input.execute({ action: "control", repo: input.source.pin.repo, request });
    current();
    if (epoch !== responseEpoch) throw new Error("chi-control-response-invalidated");
    if (result.kind !== "control" || result.actor !== input.context.actor)
      throw new Error("chi-control-context-changed");
    const view = CoDriveViewSchema.parse(result.view);
    if (
      view.sourceId !== input.source.pin.sourceId ||
      view.pin.repo !== input.source.pin.repo ||
      view.pin.deployment !== input.source.pin.deployment
    )
      throw new Error("chi-control-context-changed");
    return view;
  };
  const locked = <T>(run: () => Promise<T>) => withOperationStorage(input.storage, key, run);
  async function clear(request: CoDriveRequest) {
    await locked(async () => {
      const raw = await input.storage.getItem(key);
      if (
        raw &&
        JSON.stringify(savedSchema.parse(JSON.parse(raw)).request) === JSON.stringify(request)
      )
        await input.storage.removeItem(key);
    });
  }
  async function observe(view: CoDriveView) {
    const pending = state.pending;
    if (
      pending?.action === "submit" &&
      view.operation?.id === pending.id &&
      ["recorded", "canceled"].includes(view.operation.phase)
    ) {
      await clear(pending);
      current();
      publish({
        view,
        pending: null,
        phase: "ready",
        text: "",
        draft: state.draft + 1,
        error: null,
      });
    } else publish({ view, phase: pending ? "pending" : "ready", error: null });
  }
  async function refresh() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (reading || closed) return;
    reading = true;
    try {
      const pending = state.pending;
      await observe(
        await execute({
          action: "read",
          sourceId: input.source.pin.sourceId,
          ...(pending?.action === "submit" ? { operationId: pending.id } : {}),
        }),
      );
    } catch (error) {
      responseEpoch++;
      publish({
        phase: input.isCurrent() ? "failed" : "blocked",
        view: null,
        error: error instanceof Error ? error.message : "chi-control-unavailable",
      });
    } finally {
      reading = false;
      if (!closed) timer = setTimeout(() => void refresh(), 3000);
    }
  }
  async function submit(request: CoDriveRequest) {
    try {
      current();
      request = CoDriveRequestSchema.parse(request);
      if (
        request.action === "submit" &&
        (Buffer.byteLength(request.text, "utf8") > 8000 || /[\uD800-\uDFFF]/u.test(request.text))
      )
        throw new Error("Message exceeds the supported text bound.");
      await locked(async () => {
        const raw = await input.storage.getItem(key);
        if (raw) {
          const saved = savedSchema.parse(JSON.parse(raw));
          if (
            !sameMentionContext(saved.context, input.context) ||
            JSON.stringify(saved.request) !== JSON.stringify(request)
          )
            throw new Error("chi-control-saved-operation-conflict");
        } else
          await input.storage.setItem(key, JSON.stringify({ context: input.context, request }));
      });
      current();
      publish({ pending: request, phase: "pending", error: null });
      const view = await execute(request);
      if (request.action !== "submit") {
        await clear(request);
        publish({ pending: null });
      }
      await observe(view);
    } catch (error) {
      responseEpoch++;
      publish({
        phase: input.isCurrent() ? "failed" : "blocked",
        view: null,
        error: error instanceof Error ? error.message : "chi-control-unavailable",
      });
    }
  }
  async function load() {
    try {
      const raw = await input.storage.getItem(key);
      current();
      if (raw) {
        const saved = savedSchema.parse(JSON.parse(raw));
        if (!sameMentionContext(saved.context, input.context)) {
          publish({
            phase: "blocked",
            error:
              "Saved operation belongs to a previous authorization context. Restore/reconcile that context; it will not be resent.",
          });
          return;
        }
        publish({
          pending: saved.request,
          text: saved.request.action === "submit" ? saved.request.text : "",
        });
      }
      await refresh();
    } catch {
      publish({
        phase: "blocked",
        error: "Saved control state is unavailable; it was not replaced.",
      });
    }
  }
  let started = false;
  return {
    start() {
      if (!started) {
        started = true;
        void load();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    close() {
      closed = true;
      responseEpoch++;
      if (timer) clearTimeout(timer);
      listeners.clear();
    },
    selectPin(pin: ChiEntryRef["pin"]) {
      selected = { ...pin };
    },
    setText(text: string) {
      if (!state.pending) publish({ text });
    },
    setRecipient(recipient: string) {
      if (!state.pending) publish({ recipient });
    },
    refresh,
    retry() {
      if (state.pending) void submit(state.pending);
      else void refresh();
    },
    async cancel() {
      const pending = state.pending;
      if (pending?.action !== "submit" || state.view?.operation?.phase !== "queued") return;
      try {
        await observe(
          await execute({ action: "cancel", sourceId: pending.sourceId, id: pending.id }),
        );
      } catch (error) {
        responseEpoch++;
        publish({
          phase: "failed",
          view: null,
          error: error instanceof Error ? error.message : "chi-control-unavailable",
        });
      }
    },
    async clearStaleGrant() {
      const pending = state.pending,
        view = state.view;
      if (pending?.action !== "grant" || !view || view.ownerId !== input.context.actor) return;
      if (
        (view.control?.generation ?? 0) <= pending.generation &&
        view.pin.count <= pending.expectedPin.count
      )
        return;
      await clear(pending);
      current();
      publish({ pending: null, phase: "ready", error: null });
    },
    grant() {
      const view = state.view;
      if (
        !view ||
        !view.canGrantHere ||
        view.ownerId !== input.context.actor ||
        state.pending ||
        !samePin(selected, view.pin)
      )
        return;
      const recipient = `github:${state.recipient.trim().replace(/^@/, "").toLowerCase()}`;
      void submit({
        action: "grant",
        sourceId: view.sourceId,
        id: input.uuid(),
        generation: view.control?.generation ?? 0,
        recipient,
        expectedPin: { ...selected },
      });
    },
    async revoke() {
      const view = state.view;
      if (!view?.control || view.ownerId !== input.context.actor) return;
      const revokeKey = `${key}:revoke:${view.control.generation}`;
      try {
        current();
        const request = await withOperationStorage(input.storage, revokeKey, async () => {
          const raw = await input.storage.getItem(revokeKey);
          if (raw) {
            const saved = savedSchema.parse(JSON.parse(raw));
            if (
              !sameMentionContext(saved.context, input.context) ||
              saved.request.action !== "revoke"
            )
              throw new Error("chi-control-context-changed");
            return saved.request;
          }
          const next: CoDriveRequest = {
            action: "revoke",
            sourceId: view.sourceId,
            id: input.uuid(),
            generation: view.control!.generation,
          };
          await input.storage.setItem(
            revokeKey,
            JSON.stringify({ context: input.context, request: next }),
          );
          return next;
        });
        const result = await execute(request);
        await input.storage.removeItem(revokeKey);
        // Revocation remains available even if an earlier grant reply was lost.
        if (state.pending?.action === "grant") {
          await clear(state.pending);
          publish({ pending: null });
        }
        await observe(result);
      } catch (error) {
        responseEpoch++;
        publish({
          phase: input.isCurrent() ? "failed" : "blocked",
          view: null,
          error: error instanceof Error ? error.message : "chi-control-unavailable",
        });
      }
    },
    send(displayedDigest: string) {
      const view = state.view;
      if (
        !view?.ready ||
        !view.control?.active ||
        view.control.recipient !== input.context.actor ||
        state.pending ||
        !samePin(selected, view.pin) ||
        displayedDigest !== view.control.contextDigest ||
        !state.text.trim() ||
        state.text.trimStart().startsWith("/")
      )
        return;
      void submit({
        action: "submit",
        sourceId: view.sourceId,
        id: input.uuid(),
        generation: view.control.generation,
        contextDigest: displayedDigest,
        expectedPin: { ...selected },
        text: state.text,
      });
    },
  };
}
