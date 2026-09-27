import { useFetchQuery } from "@/data/query";
import { useQueryClient } from "@tanstack/react-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { clearMentionSelection } from "./mention-selection";
import { useMentionScope } from "./use-mention-scope";

export function useMentionParticipants(serverId: string, agentId: string, active: boolean) {
  const cache = useQueryClient();
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
  const { scope, state } = useMentionScope(serverId, workspaceId ?? "", client, supported && connected && active && Boolean(workspaceId));
  return useFetchQuery({
    queryKey: ["chiParticipants", serverId, workspaceId, connected, active, state.generation],
    enabled: supported && connected && active && Boolean(workspaceId) && Boolean(state.context),
    dataShape: "value",
    retry: false,
    gcTime: 0,
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client || !workspaceId) throw new Error("Host disconnected");
      try {
        const result = await scope.run({ action: "participants" });
        if (result.kind !== "participants") throw new Error("Unable to load people");
        return result.participants.map(participant => ({ ...participant, context: result.context }));
      } catch (error) {
        cache.setQueryData(["chiParticipants", serverId, workspaceId, connected, active], null);
        clearMentionSelection(serverId, agentId);
        throw error;
      }
    },
  });
}
