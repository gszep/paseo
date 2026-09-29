import { expect, test } from "vitest";
import type { ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { mentionRefreshIntervalMs } from "./use-mention-scope";
import { inboxQueryOptions } from "./inbox-query";

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

  expect(options.queryKey).toEqual(["chi", "host", "", "inbox", false]);
  expect(options.enabled).toBe(true);
  expect(options.refetchOnWindowFocus).toBe("always");
  expect(options.refetchOnReconnect).toBe(true);
  expect(options.refetchInterval).toBe(mentionRefreshIntervalMs);

  const page = await options.queryFn({ pageParam: undefined });
  expect(calls).toEqual([
    { operation: { action: "inbox", inbox: false, cursor: undefined }, expected: context },
  ]);
  expect(options.getNextPageParam(page)).toBe("next");
});
