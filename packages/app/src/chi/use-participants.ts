import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { clearMentionSelection } from "./mention-selection";
import { useMentionScope } from "./use-mention-scope";
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
  const { scope, state } = useMentionScope(
    serverId,
    workspaceId ?? "",
    client,
    supported && connected && active && Boolean(workspaceId),
  );
  return useFetchQuery({
    queryKey: [
      ...mentionQueryKey(serverId, workspaceId ?? "", state),
      "participants",
      connected,
      active,
    ],
    enabled: supported && connected && active && Boolean(workspaceId) && Boolean(state.context),
    dataShape: "value",
    retry: false,
    gcTime: 0,
    staleTimeMs: 0,
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
}
