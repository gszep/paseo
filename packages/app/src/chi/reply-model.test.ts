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
