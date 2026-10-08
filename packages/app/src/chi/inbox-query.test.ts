import { expect, test } from "vitest";
import type { ChiHandoff, ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { mentionRefreshIntervalMs } from "./use-mention-scope";
import { inboxDetailQueryOptions, inboxQueryOptions } from "./inbox-query";

const context: ChiMentionContext = {
  actor: "github:alice",
  repo: "*",
  generation: "a".repeat(64),
};

test("inbox refresh is automatic and never manual", async () => {
  const calls: unknown[] = [];
  const options = inboxQueryOptions({
    queryKey: ["chi", "host", ""],
    inbox: false,
    repo: "github:acme/one",
    enabled: true,
    context,
    run: async (operation, expected) => {
      calls.push({ operation, expected });
      return {
        kind: "inbox",
        actor: "github:alice",
        handoffs: [],
        nextCursor: "next",
        unreadCount: 0,
        context,
      };
    },
  });

  expect(options.queryKey).toEqual(["chi", "host", "", "inbox", false, "github:acme/one"]);
  expect(options.enabled).toBe(true);
  expect(options.refetchOnWindowFocus).toBe("always");
  expect(options.refetchOnReconnect).toBe(true);
  expect(options.refetchInterval).toBe(mentionRefreshIntervalMs);

  const page = await options.queryFn({ pageParam: undefined });
  expect(calls).toEqual([
    {
      operation: { action: "inbox", inbox: false, cursor: undefined, repo: "github:acme/one" },
      expected: context,
    },
  ]);
  expect(options.getNextPageParam(page)).toBe("next");
});

test("an open handoff detail carries the same automatic-refresh contract", async () => {
  const handoff: ChiHandoff = {
    schemaVersion: 1,
    id: "11111111-1111-4111-8111-111111111111",
    repo: "github:acme/one",
    author: "github:alice",
    recipient: "github:bob",
    text: "please review",
    sources: [{ kind: "neutral", id: "s1", snapshot: "a".repeat(64), entryId: "e1" }],
    state: "open",
    revision: 4,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    events: [],
  };
  const calls: unknown[] = [];
  const options = inboxDetailQueryOptions({
    queryKey: ["chi", "host", ""],
    repo: handoff.repo,
    id: handoff.id,
    run: async (operation) => {
      calls.push(operation);
      return { kind: "handoff", actor: "github:bob", handoff };
    },
  });

  expect(options.queryKey).toEqual(["chi", "host", "", "handoff", handoff.repo, handoff.id]);
  expect(options.refetchOnWindowFocus).toBe("always");
  expect(options.refetchOnReconnect).toBe(true);
  expect(options.refetchInterval).toBe(mentionRefreshIntervalMs);

  expect(await options.queryFn()).toEqual(handoff);
  expect(calls).toEqual([{ action: "read", id: handoff.id, repo: handoff.repo }]);
});
