import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useHosts,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeClient,
  getHostRuntimeStore,
} from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { inboxContextObserver, useMentionScope } from "./use-mention-scope";
import { mentionQueryKey } from "./mention-context";
import type {
  ChiMentionContext,
  ChiMentionOperation,
  ChiMentionResult,
} from "@getpaseo/protocol/chi-mentions";
import { inboxAuthority } from "./inbox-identity";
import { inboxHostsSettled } from "./inbox-authority";
import { inboxTransportQueryOptions, useInboxQuery } from "./inbox-query";
import { useFetchQuery } from "@/data/query";

export function useInboxTransport({ deploymentInbox: requireDeploymentInbox = false } = {}) {
  const hosts = useHosts();
  const active = useActiveWorkspaceSelection();
  const ids = useMemo(() => hosts.map((h) => h.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(ids);
  const capable = useSessionStore(
    useShallow((state) =>
      ids.filter((id) => {
        const features = state.sessions[id]?.serverInfo?.features;
        return requireDeploymentInbox
          ? features?.chiDeploymentInbox === true
          : features?.chiInboxActivity === true;
      }),
    ),
  );
  const candidates = ids.filter((id) => statuses.get(id) === "online" && capable.includes(id));
  const selectionKey = JSON.stringify([candidates, active?.serverId, requireDeploymentInbox]);
  // A host that is still connecting (or has not reported since load) is not a
  // settled "no match"; keep the loading state instead of a false reconnect error.
  const settled = inboxHostsSettled(ids, (id) => statuses.get(id));
  const verified = useFetchQuery(
    inboxTransportQueryOptions(selectionKey, () =>
      inboxAuthority.resolve(candidates, active?.serverId, async (id) => {
        const observe = inboxContextObserver(id);
        try {
          const runtime = getHostRuntimeStore().getSnapshot(id);
          if (!runtime?.client || runtime.connectionStatus !== "online")
            throw new Error("chi-host-disconnected");
          const result = await runtime.client.chiMentions({
            operation: { action: "scope", includeRepositories: false },
          });
          observe(result.context);
          return result.context;
        } catch (error) {
          observe();
          throw error;
        }
      }),
    ),
  );
  const host = verified.isError ? "" : (verified.data ?? "");
  const client = useHostRuntimeClient(host);
  const { scope, state } = useMentionScope(host, "", client, Boolean(host && client));
  const queryKey = mentionQueryKey(host, "", state);
  let transportError = settled && verified.error ? verified.error.message : "";
  if (settled && requireDeploymentInbox && !candidates.length)
    transportError = "Connect or update a host with deployment-wide Mentions support.";
  return {
    host,
    client,
    scope,
    state,
    queryKey,
    transportError,
    verifying: verified.isPending || (!host && !settled),
  };
}

export function useInbox(
  transport: ReturnType<typeof useInboxTransport>,
  options: { paused?: boolean; autoContinue?: boolean; inbox?: boolean } = {},
) {
  const { scope, state, host, queryKey } = transport;
  return useInboxQuery({
    queryKey,
    inbox: true,
    ...options,
    enabled: Boolean(host && state.context?.deploymentInbox),
    context: state.context ?? undefined,
    run: scope.run,
  });
}

export interface InboxContext {
  identity: ChiMentionContext;
  queryKey: readonly unknown[];
  execute(operation: ChiMentionOperation): Promise<ChiMentionResult>;
  isCurrent(): boolean;
}

export function useInboxReader(options: Parameters<typeof useInboxTransport>[0] = {}) {
  const transport = useInboxTransport(options);
  const { scope, state, queryKey } = transport;
  const context = useMemo<InboxContext | null>(() => {
    const identity = state.context;
    if (!identity) return null;
    return {
      identity,
      queryKey,
      execute: (operation) => scope.run(operation, identity),
      isCurrent: () =>
        scope.getState().generation === state.generation && scope.getState().context === identity,
    };
  }, [scope, state, queryKey]);
  return { ...transport, context };
}
