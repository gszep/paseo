import { expect, test } from "vitest";
import { encodeEntry } from "@henkaku-center/chi-native/append-codec";
import { boundedPinnedContext, pinnedTimelineEntries } from "./pinned-timeline.js";
import { STRUCTURED_OUTPUT_TOOL } from "../agent/providers/opencode/v2/structured-output.js";

function envelope(native: unknown, seq: number) {
  return encodeEntry({
    v: 3,
    seq,
    kind: "message",
    minimiser: "min-v1",
    payload: { native: JSON.stringify(native) },
  });
}
const user = {
  id: "msg_target",
  type: "user",
  time: { created: 1234 },
  text: "A shared mention",
  metadata: { paseoClientMessageId: "local-only-correlation" },
};
const assistant = {
  id: "msg_reply",
  type: "assistant",
  agent: "build",
  model: { id: "fixture", providerID: "fixture" },
  time: { created: 2345 },
  content: [
    { type: "text", text: "Reply" },
    { type: "reasoning", text: "Reasoning" },
  ],
};

test("uses ordinary V2 rows with exact native IDs, explicit historical time and immutable bytes", () => {
  const bytes = [
    envelope(user, 27),
    envelope(
      { ...assistant, providerState: { retained: "opaque-state-is-not-a-presentation-contract" } },
      28,
    ),
  ];
  const before = [...bytes];
  expect(pinnedTimelineEntries(bytes, 27)).toEqual([
    {
      nativeId: "msg_target",
      seq: 27,
      type: "user",
      timestamp: "1970-01-01T00:00:01.234Z",
      items: [{ type: "user_message", text: "A shared mention", messageId: "msg_target" }],
    },
    {
      nativeId: "msg_reply",
      seq: 28,
      type: "assistant",
      timestamp: "1970-01-01T00:00:02.345Z",
      items: [
        { type: "assistant_message", text: "Reply", messageId: "msg_reply" },
        { type: "reasoning", text: "Reasoning" },
      ],
    },
  ]);
  expect(bytes).toEqual(before);
});

test.each([
  { ...user, time: undefined },
  { ...user, time: { created: 1e20 } },
  { ...user, type: "unknown-private-type", text: "private diagnostic canary" },
  { ...assistant, content: [{ type: "unknown-private-part", text: "private diagnostic canary" }] },
])("rejects malformed/unknown records with a fixed safe error", (native) => {
  expect(() => pinnedTimelineEntries([envelope(native, 27)], 27)).toThrow(
    /^chi-mention-invalid-response$/,
  );
});

test("rejects a valid record at the wrong chain position", () => {
  expect(() => pinnedTimelineEntries([envelope(user, 28)], 27)).toThrow(
    /^chi-mention-invalid-response$/,
  );
});

test("bounds UTF-8 bytes after normalization, not only record count or string length", () => {
  const result = {
    kind: "context" as const,
    actor: "github:reader",
    source: {
      kind: "neutral" as const,
      id: "a".repeat(64),
      snapshot: "b".repeat(64),
      entryId: "0",
    },
    entries: [
      {
        nativeId: "msg_0",
        type: "user",
        seq: 0,
        timestamp: "2020-01-01T00:00:00Z",
        items: [{ type: "user_message" as const, text: "雪".repeat(350000), messageId: "msg_0" }],
      },
    ],
    nextCursor: null,
  };
  expect(JSON.stringify(result).length).toBeLessThan(1024 * 1024);
  expect(() => boundedPinnedContext(result)).toThrow(/^chi-mention-source-too-large$/);
});

test("bounds normalized rows per record and per page", () => {
  const record = {
    ...assistant,
    content: Array.from({ length: 257 }, () => ({ type: "text", text: "x" })),
  };
  expect(() => pinnedTimelineEntries([envelope(record, 0)], 0)).toThrow(
    /^chi-mention-invalid-response$/,
  );
  const page = Array.from({ length: 8 }, (_, seq) =>
    envelope(
      {
        ...assistant,
        id: `msg_${seq}`,
        content: Array.from({ length: 65 }, () => ({ type: "text", text: "x" })),
      },
      seq,
    ),
  );
  expect(() => pinnedTimelineEntries(page, 0)).toThrow(/^chi-mention-invalid-response$/);
});

test("overlapping pages cannot reinterpret a pinned entry from an earlier structured-output request", () => {
  const native = Array.from({ length: 11 }, (_, seq) => ({ ...user, id: `msg_${seq}` }));
  const bytes = native.map((message, seq) => envelope(message, seq));
  bytes[0] = envelope(
    { ...user, id: "msg_0", metadata: { paseoOutputSchema: { type: "object" } } },
    0,
  );
  for (const seq of [1, 2, 3]) {
    bytes[seq] = envelope(
      { id: `msg_${seq}`, type: "system", time: { created: 1234 }, text: "Stored system context" },
      seq,
    );
  }
  bytes[4] = envelope(
    {
      ...assistant,
      id: "msg_4",
      content: [
        { type: "text", text: "Draft prose" },
        {
          type: "tool",
          id: "tool_result",
          name: STRUCTURED_OUTPUT_TOOL,
          time: { created: 2345 },
          state: {
            status: "completed",
            input: {},
            content: [{ type: "text", text: "Stored result" }],
            metadata: { paseoStructuredOutput: { answer: "final" } },
          },
        },
      ],
    },
    4,
  );
  const nearTarget = pinnedTimelineEntries(bytes.slice(3, 11), 3).find((entry) => entry.seq === 4);
  const older = pinnedTimelineEntries(bytes.slice(0, 8), 0).find((entry) => entry.seq === 4);
  expect(nearTarget).toEqual(older);
  expect(nearTarget?.items).toMatchObject([
    { type: "assistant_message", text: "Draft prose", messageId: "msg_4" },
    { type: "tool_call", name: STRUCTURED_OUTPUT_TOOL },
  ]);
});
