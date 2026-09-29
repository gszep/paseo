import type {
  ChiHandoff,
  ChiMentionContext,
  ChiMentionOperation,
  ChiMentionResult,
} from "@getpaseo/protocol/chi-mentions";
import type { MentionScope } from "./mention-context";
import { mentionRefreshIntervalMs } from "./use-mention-scope";

/**
 * The inbox read's automatic-refresh contract, kept as data so it can be
 * asserted without mounting a screen. Refresh is driven on window
 * focus/visibility, on reconnect, and on the shared mention interval; the screen
 * adds a route-focus refetch and invalidates the query after its own actions.
 *
 * There is no manual refresh control.
 */
export function inboxQueryOptions(input: {
  queryKey: readonly unknown[];
  inbox: boolean;
  enabled: boolean;
  context: ChiMentionContext | undefined;
  run: MentionScope["run"];
}) {
  return {
    queryKey: [...input.queryKey, "inbox", input.inbox],
    enabled: input.enabled,
    initialPageParam: undefined as string | undefined,
    retry: false,
    gcTime: 0,
    staleTimeMs: 0,
    refetchOnWindowFocus: "always" as const,
    refetchOnReconnect: true,
    refetchInterval: mentionRefreshIntervalMs,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const result = await input.run(
        { action: "inbox" as const, inbox: input.inbox, cursor: pageParam },
        input.context,
      );
      if (result.kind !== "inbox") throw new Error("chi-invalid-response");
      return result;
    },
    getNextPageParam: (page: { nextCursor: string | null }) => page.nextCursor ?? undefined,
  };
}

/**
 * The open handoff detail's refresh contract. Same automatic refresh as the
 * list — focus/visibility, reconnect and the shared mention interval — because
 * an open discussion must learn about replies without a manual control. The
 * interval only ticks while the app is visible, per TanStack defaults.
 */
export function inboxDetailQueryOptions(input: {
  queryKey: readonly unknown[];
  repo: string;
  id: string;
  run: (operation: ChiMentionOperation) => Promise<ChiMentionResult>;
}) {
  return {
    dataShape: "value" as const,
    queryKey: [...input.queryKey, "handoff", input.repo, input.id],
    gcTime: 0,
    staleTimeMs: 0,
    retry: false,
    refetchOnWindowFocus: "always" as const,
    refetchOnReconnect: true,
    refetchInterval: mentionRefreshIntervalMs,
    queryFn: async (): Promise<ChiHandoff> => {
      const result = await input.run({ action: "read", id: input.id, repo: input.repo });
      if (result.kind !== "handoff") throw new Error("chi-invalid-response");
      return result.handoff;
    },
  };
}
