import { useMemo } from "react";
import { useFetchInfiniteQuery } from "@/data/query";
import { useShallow } from "zustand/react/shallow";
import {
  useHosts,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeClient,
} from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useMentionScope } from "./use-mention-scope";
import { mentionQueryKey } from "./mention-context";
import { selectInboxHost } from "./inbox-host";

export function useInboxTransport() {
  const hosts = useHosts();
  const active = useActiveWorkspaceSelection();
  const ids = useMemo(() => hosts.map((h) => h.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(ids);
  const capable = useSessionStore(
    useShallow((state) =>
      ids.filter((id) => state.sessions[id]?.serverInfo?.features?.chiInbox === true),
    ),
  );
  const host = selectInboxHost(ids, active?.serverId, statuses, capable);
  const client = useHostRuntimeClient(host);
  const { scope, state } = useMentionScope(host, "", client, Boolean(host && client));
  const queryKey = mentionQueryKey(host, "", state);
  return { host, client, scope, state, queryKey };
}

export function useInbox(transport: ReturnType<typeof useInboxTransport>, inbox = true) {
  const { scope, state, host, queryKey } = transport;
  return useFetchInfiniteQuery({
    queryKey: [...queryKey, "inbox", inbox],
    enabled: Boolean(host && state.context),
    initialPageParam: undefined as string | undefined,
    retry: false,
    gcTime: 0,
    staleTimeMs: 0,
    refetchOnWindowFocus: "always",
    refetchInterval: 30_000,
    queryFn: async ({ pageParam }) => {
      const result = await scope.run(
        { action: "inbox", inbox, cursor: pageParam },
        state.context ?? undefined,
      );
      if (result.kind !== "inbox") throw new Error("chi-invalid-response");
      return result;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
