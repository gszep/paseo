import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ChiEntryRef } from "@getpaseo/protocol/chi-mentions";
import { useFetchInfiniteQuery } from "@/data/query";
import type { InboxContext } from "./use-inbox";
import {
  conversationKey,
  conversationPresentation,
  mentionWindowCursor,
  olderConversationCursor,
  validateConversationPage,
} from "./pinned-conversation";

export function usePinnedConversation(
  context: InboxContext,
  handoffId: string,
  index: number,
  ref: ChiEntryRef,
) {
  const cache = useQueryClient();
  const key = conversationKey(ref);
  const queryKey = useMemo(
    () => [...context.queryKey, "conversation", ref.pin.repo, handoffId, index, key],
    [context.queryKey, ref.pin.repo, handoffId, index, key],
  );
  const query = useFetchInfiniteQuery({
    queryKey,
    initialPageParam: mentionWindowCursor(ref),
    enabled: context.isCurrent(),
    retry: false,
    gcTime: 0,
    staleTimeMs: 0,
    maxPages: 16,
    // The enclosing handoff query reauthorizes this source every foreground
    // interval. Do not re-read an entire accumulated window on every tick.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ pageParam, signal }) => {
      try {
        const result = await context.execute({
          action: "context",
          repo: ref.pin.repo,
          id: handoffId,
          index,
          cursor: pageParam,
        });
        if (signal.aborted || !context.isCurrent()) throw new Error("chi-mention-context-changed");
        if (result.kind !== "context") throw new Error("chi-mention-invalid-response");
        return validateConversationPage(ref, result, pageParam);
      } catch (error) {
        if (!signal.aborted)
          cache.getQueryCache().find({ queryKey, exact: true })?.setState({ data: undefined });
        throw error;
      }
    },
    getPreviousPageParam: (page) => olderConversationCursor(ref, page),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const historyId = JSON.stringify(queryKey);
  const presentation = useMemo(
    () => conversationPresentation(ref, query.data?.pages ?? [], historyId),
    [ref, query.data, historyId],
  );
  const { fetchPreviousPage, fetchNextPage, isFetching, hasPreviousPage, hasNextPage } = query;
  const loadOlder = useCallback(async () => {
    if (isFetching || !hasPreviousPage) return false;
    const result = await fetchPreviousPage({ cancelRefetch: false });
    return !result.isError;
  }, [isFetching, hasPreviousPage, fetchPreviousPage]);
  const loadNewer = useCallback(async () => {
    if (isFetching || !hasNextPage) return false;
    const result = await fetchNextPage({ cancelRefetch: false });
    return !result.isError;
  }, [isFetching, hasNextPage, fetchNextPage]);
  const retry = useCallback(
    () => void cache.resetQueries({ queryKey, exact: true }),
    [cache, queryKey],
  );
  return { ...query, ...presentation, loadOlder, loadNewer, retry, queryKey, historyId };
}
