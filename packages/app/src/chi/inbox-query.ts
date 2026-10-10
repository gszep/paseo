import type {
  ChiHandoff,
  ChiMentionContext,
  ChiMentionOperation,
  ChiMentionResult,
} from "@getpaseo/protocol/chi-mentions";
import type { MentionScope } from "./mention-context";
import { mentionRefreshIntervalMs } from "./use-mention-scope";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchInfiniteQuery, useFetchQuery } from "@/data/query";

const refreshPauses = new Map<string, Set<symbol>>();
const pauseListeners = new Set<() => void>();
function subscribePause(listener: () => void) {
  pauseListeners.add(listener);
  return () => {
    pauseListeners.delete(listener);
  };
}
function useRefreshPaused(key: string, paused: boolean) {
  const shared = useSyncExternalStore(
    subscribePause,
    () => refreshPauses.has(key),
    () => false,
  );
  useEffect(() => {
    if (!paused) return;
    const owner = Symbol();
    const owners = refreshPauses.get(key) ?? new Set<symbol>();
    owners.add(owner);
    refreshPauses.set(key, owners);
    for (const listener of pauseListeners) listener();
    return () => {
      owners.delete(owner);
      if (!owners.size) refreshPauses.delete(key);
      for (const listener of pauseListeners) listener();
    };
  }, [key, paused]);
  return paused || shared
    ? { refetchInterval: false as const, refetchOnWindowFocus: false as const }
    : {};
}

// Sidebar and route share the same verified transport immediately. Verification
// is discovery only: every protected inbox read still runs through its scope.
export function inboxTransportQueryOptions(selection: string, verify: () => Promise<string>) {
  return {
    queryKey: ["chi-inbox-transport", selection],
    queryFn: verify,
    dataShape: "value" as const,
    gcTime: 0,
    staleTimeMs: 0,
    retry: false,
    refetchOnWindowFocus: "always" as const,
    refetchOnReconnect: true,
    refetchInterval: mentionRefreshIntervalMs,
  };
}

export function useInboxQuery(
  input: Parameters<typeof inboxQueryOptions>[0] & { paused?: boolean; autoContinue?: boolean },
) {
  const cache = useQueryClient();
  const options = inboxQueryOptions(input);
  const refreshPaused = useRefreshPaused(JSON.stringify(options.queryKey), input.paused === true);
  // Keep the head independently: all refresh triggers fetch exactly one page.
  // Older pages belong to one head acquisition and never survive its refresh.
  const head = useFetchQuery({
    ...options,
    ...refreshPaused,
    dataShape: "value",
    queryFn: async ({ signal }) => {
      // Older pages have no fresh authorization on a head-only refresh.
      await cache.cancelQueries({ queryKey: [...options.queryKey, "older"] });
      cache.removeQueries({ queryKey: [...options.queryKey, "older"] });
      try {
        return await options.queryFn({ pageParam: undefined });
      } catch (error) {
        // No stale fallback after an unavailable/denied read. Clear synchronously
        // before the failure is delivered to observers (not in a React effect).
        if (!signal.aborted)
          cache
            .getQueryCache()
            .find({ queryKey: options.queryKey, exact: true })
            ?.setState({ data: undefined });
        throw error;
      }
    },
  });
  const older = useFetchInfiniteQuery({
    ...options,
    queryKey: [
      ...options.queryKey,
      "older",
      cache.getQueryState(options.queryKey)?.dataUpdateCount ?? 0,
    ],
    enabled: false,
    gcTime: 0,
    initialPageParam: head.data?.nextCursor ?? undefined,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    queryFn: async ({ pageParam, signal }) => {
      try {
        return await options.queryFn({ pageParam });
      } catch (error) {
        if (signal.aborted) throw error;
        cache
          .getQueryCache()
          .find({ queryKey: options.queryKey, exact: true })
          ?.setState({ data: undefined });
        for (const query of cache
          .getQueryCache()
          .findAll({ queryKey: [...options.queryKey, "older"] }))
          query.setState({ data: undefined });
        throw error;
      }
    },
  });
  const error = head.error ?? older.error;
  const key = JSON.stringify(options.queryKey);
  useEffect(() => {
    if (error instanceof Error && error.message === "chi-inbox-invalid-cursor") {
      const queryKey = JSON.parse(key);
      cache.removeQueries({ queryKey: [...queryKey, "older"] });
      void cache.resetQueries({ queryKey, exact: true });
    }
  }, [cache, key, error]);
  const tail = head.isFetching ? undefined : older.data;
  const pages = useMemo(
    () => (input.enabled && head.data && !error ? [head.data, ...(tail?.pages ?? [])] : undefined),
    [input.enabled, head.data, error, tail],
  );
  useEffect(() => {
    const last = pages?.at(-1);
    const nextCursor = last?.nextCursor;
    if (
      input.autoContinue &&
      !head.isFetching &&
      !older.isFetching &&
      last?.handoffs.length === 0 &&
      nextCursor &&
      !tail?.pageParams.includes(nextCursor) &&
      (tail?.pages.length ?? 0) < 10
    )
      void older.fetchNextPage({ cancelRefetch: false });
  }, [input.autoContinue, pages, head.isFetching, older, tail]);
  return {
    ...head,
    error,
    isError: Boolean(error),
    data: pages
      ? {
          pages,
          pageParams: [undefined, ...(tail?.pageParams ?? [])],
        }
      : undefined,
    unavailableRepos: [
      ...new Set((pages ?? []).flatMap((page) => page.unavailableRepos ?? [])),
    ].sort(),
    isFetching: head.isFetching || older.isFetching,
    isFetchingNextPage: older.isFetching,
    hasNextPage: Boolean(tail ? older.hasNextPage : head.data?.nextCursor),
    fetchNextPage: () => {
      if (!input.enabled || head.isFetching || error || !head.data?.nextCursor)
        return Promise.resolve();
      return older.fetchNextPage({ cancelRefetch: false });
    },
  };
}

/**
 * The inbox read's automatic-refresh contract, kept as data so it can be
 * asserted without mounting a screen. Refresh is driven on window
 * focus/visibility, on reconnect, and on the shared mention interval; the screen
 * invalidates the query after its own actions. The head and sidebar share it.
 *
 * There is no manual refresh control.
 */
export function inboxQueryOptions(input: {
  queryKey: readonly unknown[];
  inbox: boolean;
  repo?: string;
  enabled: boolean;
  context: ChiMentionContext | undefined;
  run: MentionScope["run"];
}) {
  return {
    queryKey: [...input.queryKey, "inbox", input.inbox, input.repo],
    enabled: input.enabled,
    initialPageParam: undefined as string | undefined,
    retry: false,
    gcTime: 5 * 60_000,
    staleTimeMs: 0,
    refetchOnWindowFocus: "always" as const,
    refetchOnReconnect: true,
    refetchInterval: mentionRefreshIntervalMs,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const result = await input.run(
        { action: "inbox" as const, inbox: input.inbox, cursor: pageParam, repo: input.repo },
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
