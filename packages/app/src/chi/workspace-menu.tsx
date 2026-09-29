import { useCallback } from "react";
import { router } from "expo-router";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { getFocusedAgentId } from "@/plugins/command-center/context";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { MentionDelivery } from "./mention-delivery";
import { useSyncDestination } from "./use-sync-destination";

export function ChiWorkspaceMenu({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const key = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const agentId = useWorkspaceLayoutStore((state) =>
    getFocusedAgentId(key ? (state.layoutByWorkspace[key] ?? null) : null),
  );
  return agentId ? <AgentMenu key={agentId} serverId={serverId} agentId={agentId} /> : null;
}

function AgentMenu({ serverId, agentId }: { serverId: string; agentId: string }) {
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.chiNative === true,
  );
  const canonical = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.chiCanonical === true,
  );
  const provider = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.provider,
  );
  const workspaceId = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.workspaceId,
  );
  const { destination } = useSyncDestination(serverId, workspaceId ?? "");
  const move = useCallback(
    () => router.push({ pathname: "/chi", params: { sourceHost: serverId, agentId } }),
    [serverId, agentId],
  );
  // The mapping, not any GitHub remote, decides whether Chi actions apply.
  if (!supported || !destination || provider !== "opencode") return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={move} disabled={!canonical}>
        Continue on another host
      </DropdownMenuItem>
      <MentionDelivery serverId={serverId} agentId={agentId} />
    </>
  );
}
