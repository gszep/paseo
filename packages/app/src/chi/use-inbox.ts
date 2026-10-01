import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useHosts,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeClient,
  getHostRuntimeStore,
} from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useMentionScope } from "./use-mention-scope";
import { mentionQueryKey } from "./mention-context";
import { inboxAuthority } from "./inbox-identity";
import { inboxHostsSettled } from "./inbox-authority";
import { useInboxQuery } from "./inbox-query";

export function useInboxTransport() {
  const hosts = useHosts();
  const active = useActiveWorkspaceSelection();
  const ids = useMemo(() => hosts.map((h) => h.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(ids);
  const capable = useSessionStore(
    useShallow((state) =>
      ids.filter((id) => state.sessions[id]?.serverInfo?.features?.chiInbox === true),
    ),
  );
  const candidates = ids.filter((id) => statuses.get(id) === "online" && capable.includes(id));
  const selectionKey = JSON.stringify([candidates, active?.serverId]);
  // A host that is still connecting (or has not reported since load) is not a
  // settled "no match"; keep the loading state instead of a false reconnect error.
  const settled = inboxHostsSettled(ids, (id) => statuses.get(id));
  const [verified, setVerified] = useState({ key: "", host: "", error: "" });
  useEffect(() => {
    let current = true;
    const [candidateHosts, preferred] = JSON.parse(selectionKey) as [string[], string | undefined];
    async function verify() {
      try {
        const host = await inboxAuthority.resolve(candidateHosts, preferred, async (id) => {
          const runtime = getHostRuntimeStore().getSnapshot(id);
          if (!runtime?.client || runtime.connectionStatus !== "online")
            throw new Error("chi-host-disconnected");
          const result = await runtime.client.chiMentions({ operation: { action: "scope" } });
          return result.context;
        });
        if (current) setVerified({ key: selectionKey, host, error: "" });
      } catch (error) {
        if (!current) return;
        // Still settling: leave the previous (or loading) state so a transient
        // connection failure never renders the reconnect error.
        if (!settled) return;
        setVerified({
          key: selectionKey,
          host: "",
          error: error instanceof Error ? error.message : "Reconnect your Chi inbox host.",
        });
      }
    }
    void verify();
    const timer = setInterval(() => void verify(), 30_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [selectionKey, settled]);
  const host = verified.key === selectionKey ? verified.host : "";
  const client = useHostRuntimeClient(host);
  const { scope, state } = useMentionScope(host, "", client, Boolean(host && client));
  const queryKey = mentionQueryKey(host, "", state);
  return {
    host,
    client,
    scope,
    state,
    queryKey,
    transportError: verified.key === selectionKey ? verified.error : "",
    verifying: verified.key !== selectionKey,
  };
}

export function useInbox(transport: ReturnType<typeof useInboxTransport>, inbox = true) {
  const { scope, state, host, queryKey } = transport;
  return useInboxQuery({
    queryKey,
    inbox,
    enabled: Boolean(host && state.context),
    context: state.context ?? undefined,
    run: scope.run,
  });
}
