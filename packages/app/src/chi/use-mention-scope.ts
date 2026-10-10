import { useEffect, useMemo, useSyncExternalStore } from "react";
import { focusManager, onlineManager } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { queryClient } from "@/data/query-client";
import { createMentionScope, reconcileMentionScope, type MentionScope } from "./mention-context";
import type { ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { clearHostMentionSelection } from "./mention-selection";
import { inboxAuthority } from "./inbox-identity";
import { ChiOperationError } from "@getpaseo/protocol/chi-mentions";

export const mentionRefreshIntervalMs = 30_000;

const scopes = new Map<string, { client: DaemonClient | null; scope: MentionScope }>();
function scopeFor(host: string, workspace: string, client: DaemonClient | null) {
  const key = JSON.stringify([host, workspace]);
  const previous = scopes.get(key);
  if (previous?.client === client) return previous.scope;
  previous?.scope.lose();
  const scope = createMentionScope(
    async (operation, expectedContext) => {
      if (!client) throw new Error("chi-host-disconnected");
      const result = await client.chiMentions({
        workspaceId: workspace || undefined,
        operation:
          !workspace && operation.action === "scope"
            ? { ...operation, includeRepositories: false }
            : operation,
        expectedContext,
      });
      if (!workspace && !inboxAuthority.accepts(result.context))
        throw new ChiOperationError(
          "Reconnect a host signed in to your Chi inbox account and deployment.",
          { accessLost: true, outcome: "unknown" },
        );
      return result;
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
export function inboxContextObserver(host: string) {
  const key = JSON.stringify([host, ""]);
  const entry = scopes.get(key);
  const generation = entry?.scope.getState().generation;
  return (context?: ChiMentionContext) => {
    if (entry && scopes.get(key) === entry) reconcileMentionScope(entry.scope, context, generation);
  };
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
    if (!active) return;
    function reacquire() {
      if (focusManager.isFocused() && onlineManager.isOnline() && !scope.getState().context)
        void scope.acquire().catch(() => undefined);
    }
    // Protected queries are disabled after access loss. Recovery must outlive those
    // queries, and must not retry immediately on every failed acquisition's state change.
    const unsubscribeFocus = focusManager.subscribe(reacquire);
    const unsubscribeOnline = onlineManager.subscribe(reacquire);
    const interval = setInterval(reacquire, mentionRefreshIntervalMs);
    reacquire();
    return () => {
      clearInterval(interval);
      unsubscribeFocus();
      unsubscribeOnline();
    };
  }, [scope, active]);
  return { scope, state };
}
