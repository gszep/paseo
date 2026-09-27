import { expect, test } from "vitest";
import type { ChiHandoff, ChiMentionOperation } from "@getpaseo/protocol/chi-mentions";
import { ChiOperationError } from "@getpaseo/protocol/chi-mentions";
import { openReplyForm } from "./reply-model";

const handoff: ChiHandoff = {
  schemaVersion: 1,
  id: "3fad06da-0902-405e-9476-ac1d8fdd9480",
  repo: "github:fixture/repo",
  author: "github:sender",
  recipient: "github:recipient",
  text: "question",
  sources: [{ kind: "neutral", id: "a".repeat(64), snapshot: "b".repeat(64), entryId: "exact" }],
  state: "acknowledged",
  revision: 2,
  createdAt: "2026-09-25",
  updatedAt: "2026-09-25",
  events: [],
};
const context = { actor: handoff.recipient, repo: handoff.repo, generation: "a".repeat(64) };
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
}

test("reload retries the immutable reply operation without changing text, identity or expected revision", async () => {
  const disk = storage();
  const sent: ChiMentionOperation[] = [];
  const updates: ChiHandoff[] = [];
  const deps = {
    handoff,
    context,
    key: "test",
    storage: disk,
    uuid: () => "fb2aed79-8a81-46f4-bf03-311f9a61337e",
    onSuccess: (value: ChiHandoff) => {
      updates.push(value);
    },
  };
  const failed = openReplyForm({
    ...deps,
    execute: async (op) => {
      sent.push(op);
      throw new Error("chi-mentions-unavailable");
    },
  });
  failed.setText("Preserve this reply");
  await failed.send("reply");
  expect(failed.getState().status).toBe("failed");
  failed.setText("Changed text");
  expect(failed.getState().text).toBe("Preserve this reply");
  failed.close();
  const recovered = openReplyForm({
    ...deps,
    handoff: { ...handoff, revision: 7 },
    uuid: () => {
      throw new Error("Retry must retain operation ID");
    },
    execute: async (op) => {
      sent.push(op);
      return { kind: "handoff", actor: handoff.recipient, handoff: { ...handoff, revision: 3 } };
    },
  });
  await recovered.send("reply");
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[0]).toMatchObject({ action: "reply", revision: 2, text: "Preserve this reply" });
  expect(await disk.getItem("test")).toBeNull();
  expect(updates).toHaveLength(1);
});

test("an acknowledged response remains discussion and an explicit conflict refresh discards only its rejected operation", async () => {
  const disk = storage();
  const form = openReplyForm({
    handoff,
    context,
    key: "conflict",
    storage: disk,
    uuid: () => "fb2aed79-8a81-46f4-bf03-311f9a61337e",
    onSuccess: () => {
      throw new Error("No successful response");
    },
    execute: async () => {
      throw new ChiOperationError("chi-mentions-http-409", {
        accessLost: false,
        outcome: "not_committed",
      });
    },
  });
  form.setText("Conflicting reply");
  await form.send("reply");
  expect(form.getState()).toMatchObject({ status: "failed", operation: { revision: 2 } });
  await form.discardConflict();
  expect(form.getState()).toMatchObject({ status: "editing", operation: null });
  expect(await disk.getItem("conflict")).toBeNull();
});

test("unreadable pending storage blocks replacement operations", async () => {
  const disk = storage();
  await disk.setItem("corrupt", "invalid saved data");
  let sends = 0;
  const form = openReplyForm({
    handoff,
    context,
    key: "corrupt",
    storage: disk,
    uuid: () => "fb2aed79-8a81-46f4-bf03-311f9a61337e",
    onSuccess: () => undefined,
    execute: async () => {
      sends++;
      return { kind: "handoff", actor: handoff.recipient, handoff };
    },
  });
  await form.send("acknowledge");
  form.setText("Do not overwrite the unknown pending operation");
  await form.send("reply");
  expect(sends).toBe(0);
  expect(form.getState().status).toBe("blocked");
  expect(await disk.getItem("corrupt")).toBe("invalid saved data");
});

test("confirmed replies remain delivered when local cleanup fails", async () => {
  const disk = storage();
  let delivered = 0;
  const form = openReplyForm({
    handoff,
    context,
    key: "cleanup",
    storage: {
      ...disk,
      removeItem: async () => {
        throw new Error("storage unavailable");
      },
    },
    uuid: () => "fb2aed79-8a81-46f4-bf03-311f9a61337e",
    onSuccess: () => {
      delivered++;
    },
    execute: async () => ({ kind: "handoff", actor: handoff.recipient, handoff }),
  });
  form.setText("Confirmed reply");
  await form.send("reply");
  expect(form.getState().status).toBe("sent");
  expect(delivered).toBe(1);
});

test("lost reply response followed by restore failure cannot generate a replacement operation", async () => {
  const disk = storage();
  const calls: ChiMentionOperation[] = [];
  let generated = 0;
  const deps = {
    handoff,
    context,
    key: "lost-response",
    storage: disk,
    uuid: () => {
      generated++;
      return "fb2aed79-8a81-46f4-bf03-311f9a61337e";
    },
    onSuccess: () => undefined,
    execute: async (op: ChiMentionOperation) => {
      calls.push(op);
      throw new Error("response lost after commit");
    },
  };
  const first = openReplyForm(deps);
  first.setText("Exactly once");
  await first.send("reply");
  first.close();
  const saved = await disk.getItem(deps.key);
  const restored = openReplyForm({
    ...deps,
    storage: {
      ...disk,
      getItem: async () => {
        throw new Error("restore failed");
      },
    },
  });
  await restored.send("reply");
  restored.setText("Do not send this duplicate");
  await restored.send("reply");
  await restored.discardConflict();
  expect(restored.getState()).toMatchObject({ status: "blocked", text: "", operation: null });
  expect(generated).toBe(1);
  expect(calls).toHaveLength(1);
  expect(await disk.getItem(deps.key)).toBe(saved);
  restored.close();
  const recovered = openReplyForm({
    ...deps,
    execute: async (op) => {
      calls.push(op);
      return { kind: "handoff", actor: context.actor, handoff };
    },
  });
  await recovered.send("reply");
  expect(calls[1]).toEqual(calls[0]);
  expect(generated).toBe(1);
});

test("a saved reply from another auth generation blocks instead of adopting a new identity", async () => {
  const disk = storage();
  const deps = {
    handoff,
    context,
    key: "authority",
    storage: disk,
    uuid: () => "fb2aed79-8a81-46f4-bf03-311f9a61337e",
    onSuccess: () => undefined,
  };
  const first = openReplyForm({
    ...deps,
    execute: async () => {
      throw new Error("lost reply");
    },
  });
  first.setText("Preserve actor");
  await first.send("reply");
  first.close();
  const next = openReplyForm({
    ...deps,
    context: { ...context, generation: "b".repeat(64) },
    execute: async () => {
      throw new Error("must not execute");
    },
  });
  await next.send("reply");
  expect(next.getState().status).toBe("blocked");
});

test("closed A completion cannot erase B after remount observes committed A and B loses its response", async () => {
  const disk = storage();
  let finishA!: (value: import("@getpaseo/protocol/chi-mentions").ChiMentionResult) => void;
  let enteredA!: () => void;
  const started = new Promise<void>((resolve) => {
    enteredA = resolve;
  });
  const response = new Promise<import("@getpaseo/protocol/chi-mentions").ChiMentionResult>(
    (resolve) => {
      finishA = resolve;
    },
  );
  const aId = "fb2aed79-8a81-46f4-bf03-311f9a61337e";
  const bId = "ab2aed79-8a81-46f4-bf03-311f9a61337e";
  const committed = {
    ...handoff,
    revision: 3,
    replies: [{ id: aId, actor: context.actor, text: "A", at: "now", revision: 3 }],
  };
  const deps = {
    handoff,
    context,
    key: "race",
    storage: disk,
    uuid: () => aId,
    onSuccess: () => undefined,
  };
  const a = openReplyForm({
    ...deps,
    execute: async () => {
      enteredA();
      return response;
    },
  });
  a.setText("A");
  const sendingA = a.send("reply");
  await started;
  a.close();
  const b = openReplyForm({
    ...deps,
    handoff: committed,
    uuid: () => bId,
    execute: async () => {
      throw new Error("B committed, response lost");
    },
  });
  // Await the real restore transaction by subscribing to its state transition.
  await new Promise<void>((resolve) => {
    const unsubscribe = b.subscribe(() => {
      if (b.getState().status === "sent") {
        unsubscribe();
        resolve();
      }
    });
  });
  b.setText("B");
  await b.send("reply");
  const savedB = await disk.getItem("race");
  finishA({ kind: "handoff", actor: context.actor, handoff: committed });
  await sendingA;
  expect(await disk.getItem("race")).toBe(savedB);
  b.close();
  const operations: ChiMentionOperation[] = [];
  const restored = openReplyForm({
    ...deps,
    handoff: committed,
    execute: async (op) => {
      operations.push(op);
      throw new Error("still uncertain");
    },
  });
  await restored.send("reply");
  expect(operations).toEqual([
    { action: "reply", id: handoff.id, operationId: bId, text: "B", revision: 3 },
  ]);
});

test.each([409, 413, 422])(
  "proven %s rejection survives reload and permits explicit correction",
  async (status) => {
    const disk = storage();
    const deps = {
      handoff,
      context,
      key: "rejected",
      storage: disk,
      uuid: () => "fb2aed79-8a81-46f4-bf03-311f9a61337e",
      onSuccess: () => undefined,
    };
    const first = openReplyForm({
      ...deps,
      execute: async () => {
        throw new ChiOperationError(`chi-mentions-http-${status}`, {
          accessLost: false,
          outcome: "not_committed",
        });
      },
    });
    first.setText("Rejected content");
    await first.send("reply");
    first.close();
    const calls: ChiMentionOperation[] = [];
    const next = openReplyForm({
      ...deps,
      uuid: () => "ab2aed79-8a81-46f4-bf03-311f9a61337e",
      execute: async (op) => {
        calls.push(op);
        return { kind: "handoff", actor: context.actor, handoff };
      },
    });
    await new Promise<void>((resolve) => {
      const off = next.subscribe(() => {
        off();
        resolve();
      });
    });
    expect(next.getState().canDiscard).toBe(true);
    await next.discardConflict();
    next.setText("Corrected");
    await next.send("reply");
    expect(calls).toEqual([
      {
        action: "reply",
        id: handoff.id,
        operationId: "ab2aed79-8a81-46f4-bf03-311f9a61337e",
        revision: 2,
        text: "Corrected",
      },
    ]);
  },
);

test("oversized reply never persists or dispatches and is immediately editable", async () => {
  const disk = storage();
  let calls = 0;
  const form = openReplyForm({
    handoff,
    context,
    key: "bounds",
    storage: disk,
    uuid: () => "fb2aed79-8a81-46f4-bf03-311f9a61337e",
    onSuccess: () => undefined,
    execute: async () => {
      calls++;
      return { kind: "handoff", actor: context.actor, handoff };
    },
  });
  form.setText("x".repeat(8001));
  await form.send("reply");
  expect(form.getState()).toMatchObject({
    status: "failed",
    operation: null,
    error: "chi-mention-text-too-long",
  });
  expect(await disk.getItem("bounds")).toBeNull();
  expect(calls).toBe(0);
  form.setText("Corrected");
  await form.send("reply");
  expect(calls).toBe(1);
});

test("failed rejected-operation cleanup stays locked and reports the storage failure", async () => {
  const disk = storage();
  const form = openReplyForm({
    handoff,
    context,
    key: "rejected-cleanup",
    storage: {
      ...disk,
      removeItem: async () => {
        throw new Error("storage unavailable");
      },
    },
    uuid: () => "fb2aed79-8a81-46f4-bf03-311f9a61337e",
    onSuccess: () => undefined,
    execute: async () => {
      throw new ChiOperationError("chi-mentions-http-422", {
        accessLost: false,
        outcome: "not_committed",
      });
    },
  });
  form.setText("Rejected text");
  await form.send("reply");
  const saved = await disk.getItem("rejected-cleanup");
  expect(await form.discardConflict()).toBe(false);
  form.setText("Cannot replace yet");
  expect(form.getState()).toMatchObject({
    status: "failed",
    text: "Rejected text",
    error: "chi-reply-storage-unavailable",
  });
  expect(await disk.getItem("rejected-cleanup")).toBe(saved);
});

test("a stale reply rejection cannot unlock correction after a remounted retry loses its response", async () => {
  const disk = storage();
  let rejectFirst!: (error: Error) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const response = new Promise<never>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const deps = {
    handoff,
    context,
    key: "reply-attempts",
    storage: disk,
    uuid: () => "fb2aed79-8a81-46f4-bf03-311f9a61337e",
    onSuccess: () => undefined,
  };
  const a = openReplyForm({
    ...deps,
    execute: async () => {
      started();
      return response;
    },
  });
  a.setText("Retry identity");
  const first = a.send("reply");
  await entered;
  const b = openReplyForm({
    ...deps,
    execute: async () => {
      throw new Error("committed, response lost");
    },
  });
  await b.send("reply");
  const saved = await disk.getItem(deps.key);
  rejectFirst(
    new ChiOperationError("chi-mentions-http-422", { accessLost: false, outcome: "not_committed" }),
  );
  await first;
  expect(a.getState().canDiscard).toBe(false);
  expect(await a.discardConflict()).toBe(false);
  expect(await disk.getItem(deps.key)).toBe(saved);
  b.close();
  const restored = openReplyForm({
    ...deps,
    execute: async () => {
      throw new Error("still uncertain");
    },
  });
  await restored.send("reply");
  expect(restored.getState()).toMatchObject({
    canDiscard: false,
    operation: { operationId: deps.uuid() },
  });
});

test("credential rotation requires explicit same-principal reauthorization and preserves reply UUID", async () => {
  const disk = storage();
  const calls: ChiMentionOperation[] = [];
  const deps = {
    handoff,
    context,
    key: "rotation",
    storage: disk,
    uuid: () => "fb2aed79-8a81-46f4-bf03-311f9a61337e",
    onSuccess: () => undefined,
    execute: async (op: ChiMentionOperation) => {
      calls.push(op);
      throw new Error("uncertain");
    },
  };
  const first = openReplyForm(deps);
  first.setText("Original reply");
  await first.send("reply");
  first.close();
  const other = openReplyForm({ ...deps, context: { ...context, actor: "github:other" } });
  await other.send("reply");
  expect(other.getState()).toMatchObject({
    status: "blocked",
    canReauthorize: false,
    text: "",
    operation: null,
  });
  await other.reauthorize();
  other.close();
  const rotated = openReplyForm({ ...deps, context: { ...context, generation: "b".repeat(64) } });
  await rotated.send("reply");
  expect(calls).toHaveLength(1);
  expect(rotated.getState()).toMatchObject({ status: "blocked", canReauthorize: true, text: "" });
  await rotated.reauthorize();
  await rotated.send("reply");
  expect(calls).toEqual([calls[0], calls[0]]);
});
