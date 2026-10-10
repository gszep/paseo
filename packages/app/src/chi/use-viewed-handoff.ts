import { useCallback, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ChiHandoff } from "@getpaseo/protocol/chi-mentions";
import type { InboxContext } from "./use-inbox";

export function useViewedHandoff(context: InboxContext, handoff: ChiHandoff) {
  const cache = useQueryClient();
  const viewed = useMutation({
    retry: false,
    mutationFn: async () => {
      const result = await context.execute({
        action: "viewed",
        repo: handoff.repo,
        id: handoff.id,
        revision: handoff.revision,
      });
      if (!context.isCurrent() || result.kind !== "handoff") return;
      cache.setQueryData(
        [...context.queryKey, "handoff", handoff.repo, handoff.id],
        result.handoff,
      );
      void cache.invalidateQueries({
        queryKey: [...context.queryKey, "inbox", true, handoff.repo],
      });
    },
  });
  const { mutate, isIdle } = viewed;
  useEffect(() => {
    if (!handoff.readAt && handoff.recipient === context.identity.actor && isIdle) mutate();
  }, [handoff.readAt, handoff.recipient, context.identity.actor, isIdle, mutate]);
  const retry = useCallback(() => mutate(), [mutate]);
  return { ...viewed, retry };
}
