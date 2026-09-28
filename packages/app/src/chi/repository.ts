import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { useSessionStore } from "@/stores/session-store";
import { useReplicaQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { checkoutStatusQueryKey } from "@/git/query-keys";
import { fetchCheckoutStatus } from "@/git/checkout-status-cache";

export function useAgentChiRepository(serverId: string, agentId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const agent = useSessionStore((state) => state.sessions[serverId]?.agents.get(agentId));
  const cwd = agent?.cwd;
  // Directory projections deliberately omit remotes. The checkout replica owns them.
  const query = useReplicaQuery({
    queryKey: checkoutStatusQueryKey(serverId, cwd ?? ""),
    pushEvent: "checkout_status_update",
    enabled: Boolean(client && connected && cwd && agent?.projectPlacement?.checkout.isGit),
    queryFn: () => {
      if (!client || !cwd) throw new Error("chi-host-disconnected");
      return fetchCheckoutStatus({ client, serverId, cwd });
    },
  });
  return (
    connected && agent?.projectPlacement?.checkout.isGit === true && hasChiRepository(query.data)
  );
}

export function hasChiRepository(
  checkout: { isGit: boolean; remoteUrl: string | null } | undefined,
): boolean {
  if (!checkout?.isGit || !checkout.remoteUrl) return false;
  const remote = parseGitRemoteLocation(checkout.remoteUrl);
  return remote?.host.toLowerCase() === "github.com";
}
