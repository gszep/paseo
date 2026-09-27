import type { ChiMentionContext, ChiMentionOperation, ChiMentionResult } from "@getpaseo/protocol/chi-mentions";

export type ScopedMentionResult = ChiMentionResult & { context: ChiMentionContext };
type ScopeState = { generation: number; context: ChiMentionContext | null; error: string | null };
export function sameMentionContext(a: ChiMentionContext, b: ChiMentionContext) {
  return a.actor === b.actor && a.repo === b.repo && a.generation === b.generation;
}

/** One authority boundary for the whole inbox tree, participant picker and delivery rail. */
export function createMentionScope(
  execute: (operation: ChiMentionOperation, expectedContext?: ChiMentionContext) => Promise<ScopedMentionResult>,
  clear: () => void,
) {
  let state: ScopeState = { generation: 0, context: null, error: null };
  const listeners = new Set<() => void>();
  let acquiring: Promise<void> | null = null;
  function publish(next: ScopeState) {
    state = next;
    for (const listener of listeners) listener();
  }
  function lose(error = "chi-mention-context-changed") {
    clear();
    acquiring = null;
    publish({ generation: state.generation + 1, context: null, error });
  }
  async function acquire() {
    if (acquiring) return acquiring;
    const generation = state.generation;
    const task = (async () => {
      try {
        const result = await execute({ action: "scope" });
        if (state.generation !== generation) throw new Error("chi-mention-context-changed");
        if (state.context && !sameMentionContext(state.context, result.context)) clear();
        publish({ context: result.context, generation: generation + 1, error: null });
      } catch (error) {
        if (state.generation === generation) lose(error instanceof Error ? error.message : "chi-mentions-unavailable");
        throw error;
      }
    })();
    acquiring = task;
    try { await task; } finally { if (acquiring === task) acquiring = null; }
  }
  async function run(operation: ChiMentionOperation): Promise<ScopedMentionResult> {
    const current = state;
    if (!current.context) throw new Error(current.error ?? "chi-mention-context-required");
    try {
      const result = await execute(operation, current.context);
      if (state.generation !== current.generation || !sameMentionContext(result.context, current.context))
        throw new Error("chi-mention-context-changed");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "chi-mentions-unavailable";
      const mutation = operation.action === "reply" || operation.action === "acknowledge" || operation.action === "retry";
      // An uncertain mutation retains its immutable retry operation. Access/context loss
      // always clears every protected view; read acquisition failures do too.
      if (state.generation === current.generation && (!mutation || /context|identity|repository|http-40[134]/.test(message))) lose(message);
      throw error;
    }
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    acquire, run, lose,
  };
}
export type MentionScope = ReturnType<typeof createMentionScope>;
