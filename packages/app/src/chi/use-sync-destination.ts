import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

export interface SyncDestination {
  id: string;
  name: string;
  endpoint: string;
  audience: "private" | "shared";
}

export interface SyncDestinationState {
  /** Null means local: no configured destination for the workspace. */
  destination: SyncDestination | null;
  pending: boolean;
  error: string | null;
  /** True until the first successful status response. Never an error or local verdict. */
  loading: boolean;
  retry: () => void;
}

export function syncDestinationQueryKey(serverId: string, workspaceId: string) {
  return ["chi-sync-status", serverId, workspaceId] as const;
}

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
  const data = query.isSuccess ? query.data : null;
  return {
    destination: data?.destination ?? null,
    pending: data?.pending ?? false,
    error: data?.error ?? null,
    loading: enabled && !query.isSuccess,
    retry,
  };
}
