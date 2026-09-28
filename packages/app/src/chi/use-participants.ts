import { useEffect } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { clearMentionSelection } from "./mention-selection";
import { mentionRefreshIntervalMs, useMentionScope } from "./use-mention-scope";
import { mentionQueryKey } from "./mention-context";

export function useMentionParticipants(serverId: string, agentId: string, active: boolean) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const workspaceId = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.workspaceId,
  );
  const supported = useSessionStore(
    (state) =>
      state.sessions[serverId]?.serverInfo?.features?.chiMentions === true &&
      state.sessions[serverId]?.agents.get(agentId)?.provider === "opencode",
  );
  const enabled = supported && connected && Boolean(workspaceId);
  const { scope, state } = useMentionScope(serverId, workspaceId ?? "", client, enabled);
  const query = useFetchQuery({
    queryKey: [...mentionQueryKey(serverId, workspaceId ?? "", state), "participants"],
    enabled: enabled && Boolean(state.context),
    dataShape: "value",
    retry: false,
    gcTime: 5 * 60_000,
    staleTimeMs: mentionRefreshIntervalMs,
    refetchInterval: mentionRefreshIntervalMs,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    queryFn: async () => {
      if (!client || !workspaceId) throw new Error("Host disconnected");
      try {
        const result = await scope.run({ action: "participants" }, state.context ?? undefined);
        if (result.kind !== "participants") throw new Error("Unable to load people");
        return result.participants.map((participant) => ({
          ownerId: participant.ownerId,
          handle: participant.handle,
          context: result.context,
        }));
      } catch (error) {
        clearMentionSelection(serverId, agentId);
        throw error;
      }
    },
  });
  const { refetch } = query;
  useEffect(() => {
    // The popup is a freshness trigger, never part of the protected directory's key.
    if (!active || !enabled) return;
    if (scope.getState().context) void refetch();
    else void scope.acquire().catch(() => undefined);
  }, [active, enabled, scope, refetch]);
  return {
    ...query,
    data: enabled && state.context ? query.data : undefined,
    isLoading: enabled && !state.error && (!state.context || query.isLoading),
  };
}
