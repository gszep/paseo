import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { getFocusedAgentId } from "@/plugins/command-center/context";
import {
  DropdownMenuItem,
  DropdownMenuHint,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { MentionDelivery } from "./mention-delivery";
import { mentionError } from "./mention-errors";
import { useAgentChiRepository } from "./repository";

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
  const client = useHostRuntimeClient(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.chiNative === true,
  );
  const canonical = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.chiCanonical === true,
  );
  const provider = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.provider,
  );
  const repository = useAgentChiRepository(serverId, agentId);
  const shared = useSessionStore((state) =>
    Boolean(state.sessions[serverId]?.agents.get(agentId)?.labels["chi.native"]),
  );
  const action = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!client) throw new Error("chi-host-disconnected");
      const result = await client.shareChi({ agentId });
      if (result.outcome === "failed") throw new Error(result.error);
    },
  });
  const { mutate } = action;
  const share = useCallback(() => mutate(), [mutate]);
  const move = useCallback(
    () => router.push({ pathname: "/chi", params: { sourceHost: serverId, agentId } }),
    [serverId, agentId],
  );
  let status: "idle" | "pending" | "success" = "idle";
  if (action.isSuccess) status = "success";
  if (action.isPending) status = "pending";
  if (!supported || !repository || provider !== "opencode") return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={share}
        closeOnSelect={false}
        disabled={action.isPending}
        status={status}
      >
        {shared ? "Capture to Chi" : "Share to Chi"}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={move} disabled={!canonical}>
        Continue on another host
      </DropdownMenuItem>
      {action.isError ? <DropdownMenuHint>{mentionError(action.error)}</DropdownMenuHint> : null}
      <MentionDelivery serverId={serverId} agentId={agentId} />
    </>
  );
}
