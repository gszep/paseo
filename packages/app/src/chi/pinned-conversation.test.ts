import { expect, test } from "vitest";
import type { ChiEntryRef } from "@getpaseo/protocol/chi-mentions";
import {
  conversationPresentation,
  mentionWindowCursor,
  olderConversationCursor,
  validateConversationPage,
  type ConversationPage,
} from "./pinned-conversation";

const ref: ChiEntryRef = {
  pin: {
    v: 3,
    deployment: "fixture",
    repo: "github:fixture/repo",
    sourceId: "a".repeat(64),
    count: 40,
    head: "b".repeat(64),
  },
  seq: 27,
};
function page(start: number): ConversationPage {
  const end = Math.min(start + 8, ref.pin.count);
  return {
    kind: "context",
    actor: "github:recipient",
    source: {
      kind: "neutral",
      id: ref.pin.sourceId,
      snapshot: ref.pin.head,
      entryId: String(ref.seq),
      appendRef: ref,
    },
    entries: Array.from({ length: end - start }, (_, n) => ({
      seq: start + n,
      nativeId: `msg_${start + n}`,
      type: "user",
      timestamp: "2020-01-01T00:00:00Z",
      items: [
        { type: "user_message", text: `Message ${start + n}`, messageId: `msg_${start + n}` },
      ],
    })),
    nextCursor: end < ref.pin.count ? `${ref.pin.head}:${end}` : null,
  };
}

test("starts around the target, maps ordinal to native ID, and never manufactures recent timestamps", () => {
  expect(mentionWindowCursor(ref)).toBe(`${ref.pin.head}:24`);
  const p = validateConversationPage(ref, page(24), mentionWindowCursor(ref));
  const result = conversationPresentation(ref, [p], "scope-a");
  expect(result.targetNativeId).toBe("msg_27");
  expect(result.items.find((row) => row.id === result.targetItemId)).toMatchObject({
    kind: "user_message",
    messageId: "msg_27",
    text: "Message 27",
    timestamp: new Date("2020-01-01T00:00:00Z"),
  });
  expect(olderConversationCursor(ref, p)).toBe(`${ref.pin.head}:16`);
  expect(p.nextCursor).toBe(`${ref.pin.head}:32`);
});

test("prepend/overlap preserve the target identity while another protected context gets different keys", () => {
  const initial = conversationPresentation(ref, [page(24)], "scope-a");
  const prepended = conversationPresentation(ref, [page(16), page(24), page(28)], "scope-a");
  expect(prepended.targetItemId).toBe(initial.targetItemId);
  expect(new Set(prepended.items.map((item) => item.id)).size).toBe(prepended.items.length);
  expect(conversationPresentation(ref, [page(24)], "scope-b").targetItemId).not.toBe(
    initial.targetItemId,
  );
});

test("rejects wrong pin, wrong ordinal, incomplete pages, mismatched native IDs and unknown timestamps", () => {
  const p = page(24);
  const invalid = [
    {
      ...p,
      source: { ...p.source, appendRef: { ...ref, pin: { ...ref.pin, head: "c".repeat(64) } } },
    },
    { ...p, entries: p.entries.map((e, i) => (i === 0 ? { ...e, seq: 999 } : e)) },
    { ...p, entries: p.entries.slice(0, 2) },
    { ...p, entries: p.entries.map((e, i) => (i === 0 ? { ...e, nativeId: "msg_other" } : e)) },
    { ...p, entries: p.entries.map((e, i) => (i === 0 ? { ...e, timestamp: undefined } : e)) },
    { ...p, nextCursor: `${"c".repeat(64)}:32` },
  ];
  for (const value of invalid)
    expect(() => validateConversationPage(ref, value, mentionWindowCursor(ref))).toThrow(
      "chi-mention-invalid-response",
    );
});
