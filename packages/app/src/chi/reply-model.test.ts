import { expect, test } from "vitest";
import type { ChiHandoff, ChiMentionOperation } from "@getpaseo/protocol/chi-mentions";
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
      throw new Error("chi-mentions-http-409");
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
