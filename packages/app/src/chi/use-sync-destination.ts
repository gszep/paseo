import { useCallback, useEffect } from "react";
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
 *
 * The status is refetched when a Chi association label changes (a capture that
 * clears its error, a paused/resumed mapping) and when the host reconnects, so a
 * successful sync clears the notice without waiting for focus.
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
  const labelSignature = useSessionStore((state) => {
    const agents = state.sessions[serverId]?.agents;
    if (!agents) return "";
    const parts: string[] = [];
    for (const agent of agents.values()) {
      if (agent.workspaceId === workspaceId) parts.push(agent.labels["chi.native"] ?? "");
    }
    return parts.sort().join("|");
  });
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
  useEffect(() => {
    if (!connected) return;
    // Coalesce a burst of label writes (one capture patches several fields) and
    // the reconnect transition into a single status refetch.
    const handle = setTimeout(() => void refetch(), 300);
    return () => clearTimeout(handle);
  }, [connected, labelSignature, refetch]);
  return deriveSyncDestinationState({
    response: query.isSuccess ? query.data : null,
    // Not resolved (disconnected, unsupported, or first load) renders nothing;
    // only a successful status is a local verdict.
    loading: !query.isSuccess,
    retry,
  });
}
