import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  deriveSyncDestinationState,
  syncDestinationQueryKey,
  type SyncDestination,
  type SyncDestinationState,
} from "./sync-destination";

export type { SyncDestination, SyncDestinationState } from "./sync-destination";
export { syncDestinationQueryKey } from "./sync-destination";

/**
 * Resolves the workspace's sync destination over the daemon RPC. This is the
 * single source of truth that replaces the former label-presence and
 * "any github.com remote" checks.
 */
export function useSyncDestination(
  serverId: string,
  workspaceId: string,
  options?: { enabled?: boolean },
): SyncDestinationState {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.chiNative === true,
  );
  const enabled =
    options?.enabled !== false && supported && connected && Boolean(client && workspaceId);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
    enabled,
    queryKey: syncDestinationQueryKey(serverId, workspaceId),
    queryFn: async () => {
      if (!client) throw new Error("chi-host-disconnected");
      const result = await client.chiSyncStatus({ workspaceId });
      if (result.outcome === "failed") throw new Error(result.error);
      return result;
    },
  });
  const { refetch } = query;
  const retry = useCallback(() => {
    if (!client) return;
    void client
      .chiSyncStatus({ workspaceId, action: "retry" })
      .then(() => refetch())
      .catch(() => undefined);
  }, [client, workspaceId, refetch]);
  return deriveSyncDestinationState({
    response: query.isSuccess ? query.data : null,
    loading: enabled && !query.isSuccess,
    retry,
  });
}
