import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { queryClient } from "@/data/query-client";
import { createMentionScope, type MentionScope } from "./mention-context";
import { clearHostMentionSelection } from "./mention-selection";

const scopes = new Map<string, { client: DaemonClient | null; scope: MentionScope }>();
function scopeFor(host: string, workspace: string, client: DaemonClient | null) {
  const key = JSON.stringify([host, workspace]);
  const previous = scopes.get(key);
  if (previous?.client === client) return previous.scope;
  previous?.scope.lose();
  const scope = createMentionScope(
    async (operation, expectedContext) => {
      if (!client) throw new Error("chi-host-disconnected");
      return client.chiMentions({ workspaceId: workspace, operation, expectedContext });
    },
    () => {
      queryClient.removeQueries({ queryKey: ["chi-mentions", host, workspace] });
      clearHostMentionSelection(host);
    },
  );
  scopes.set(key, { client, scope });
  return scope;
}
export function loseHostMentionScopes(host: string) {
  for (const [key, entry] of scopes)
    if (JSON.parse(key)[0] === host) entry.scope.lose("chi-host-disconnected");
}
export function useMentionScope(
  host: string,
  workspace: string,
  client: DaemonClient | null,
  active: boolean,
) {
  const scope = useMemo(() => scopeFor(host, workspace, client), [host, workspace, client]);
  const state = useSyncExternalStore(scope.subscribe, scope.getState, scope.getState);
  useEffect(() => {
    if (active && !scope.getState().context) void scope.acquire().catch(() => undefined);
  }, [scope, active]);
  return { scope, state };
}
