import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { useCallback, useSyncExternalStore } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { mentionError } from "./mention-errors";
import { useMentionScope } from "./use-mention-scope";
import { mentionSubmissions } from "./mention-submission-storage";
import { sameMentionContext, mentionQueryKey, type MentionScope } from "./mention-context";
import {
  mentionSelection,
  subscribeMentionSelection,
  clearMentionSelection,
} from "./mention-selection";

interface AgentTarget {
  serverId: string;
  agentId: string;
}
interface ProtectedTarget extends AgentTarget {
  client: DaemonClient;
  scope: MentionScope;
  identity: ChiMentionContext;
  queryKey: readonly unknown[];
}

export function MentionDelivery({ serverId, agentId }: AgentTarget) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const workspaceId = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.workspaceId,
  );
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.chiMentions === true,
  );
  const shared = useSessionStore((state) =>
    Boolean(state.sessions[serverId]?.agents.get(agentId)?.labels["chi.native"]),
  );
  const active = supported && shared && connected && Boolean(workspaceId);
  const { scope, state } = useMentionScope(serverId, workspaceId ?? "", client, active);
  const verify = useCallback(() => void scope.acquire().catch(() => undefined), [scope]);
  if (!supported || !workspaceId) return null;
  return (
    <View style={styles.rail}>
      <SelectedRecipients serverId={serverId} agentId={agentId} shared={shared} />
      {active && client && state.context ? (
        <ProtectedDelivery
          key={state.generation}
          serverId={serverId}
          agentId={agentId}
          client={client}
          scope={scope}
          identity={state.context}
          queryKey={mentionQueryKey(serverId, workspaceId, state)}
        />
      ) : null}
      {state.error && !state.loading ? (
        <Alert
          variant="error"
          title="Mention context unavailable"
          description={mentionError(state.error)}
        >
          <Button onPress={verify}>Verify mention context</Button>
        </Alert>
      ) : null}
    </View>
  );
}

function SelectedRecipients({ serverId, agentId, shared }: AgentTarget & { shared: boolean }) {
  const selected = useSyncExternalStore(
    subscribeMentionSelection,
    () => mentionSelection(serverId, agentId),
    () => mentionSelection(serverId, agentId),
  );
  const clear = useCallback(() => clearMentionSelection(serverId, agentId), [serverId, agentId]);
  if (!selected.length) return null;
  return (
    <View>
      <Text style={styles.text}>
        Mention recipients: {selected.map((p) => `@${p.handle}`).join(", ")}
        {shared ? "" : " · Share to Chi before sending"}
      </Text>
      <Button size="sm" variant="ghost" onPress={clear}>
        Clear recipients
      </Button>
    </View>
  );
}

function ProtectedDelivery(target: ProtectedTarget) {
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: 5000,
    queryKey: [...target.queryKey, "delivery", target.agentId],
    queryFn: async () => {
      const result = await target.scope.run(
        { action: "delivery", agentId: target.agentId },
        target.identity,
      );
      if (result.kind !== "delivery") throw new Error("chi-invalid-response");
      return result;
    },
  });
  const retry = useMutation({
    retry: false,
    mutationFn: () =>
      target.scope.run({ action: "retry", agentId: target.agentId }, target.identity),
    onSettled: () => query.refetch(),
  });
  const { mutate } = retry;
  const retryDelivery = useCallback(() => mutate(), [mutate]);
  const deliveries = query.isSuccess && !query.isFetching ? query.data.deliveries : [];
  return (
    <View>
      <SavedSend {...target} />
      {deliveries.map((d) => (
        <Text
          key={d.handoffId}
          style={styles.text}
          accessibilityRole={d.status === "failed" ? "alert" : undefined}
        >
          @{d.recipient.handle}: {deliveryText(d.status, d.error)}
        </Text>
      ))}
      {deliveries.some((d) => d.status !== "delivered") ? (
        <Button size="sm" variant="outline" disabled={retry.isPending} onPress={retryDelivery}>
          {retry.isPending ? "Retrying mentions..." : "Retry mentions"}
        </Button>
      ) : null}
      {retry.isError ? (
        <Alert
          variant="error"
          title="Mention delivery not confirmed"
          description={mentionError(retry.error)}
        />
      ) : null}
      {query.isError ? (
        <Alert
          variant="error"
          title="Mention status unavailable"
          description={mentionError(query.error)}
        />
      ) : null}
    </View>
  );
}

function SavedSend(target: ProtectedTarget) {
  const pending = useFetchQuery({
    queryKey: [...target.queryKey, "pending-send", target.agentId],
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: 2000,
    queryFn: async () => {
      const saved = await mentionSubmissions.read(target.serverId, target.agentId);
      const authorization = saved?.chiMentionAuthorization ?? saved?.chiMentionContext;
      if (saved && (!authorization || !sameMentionContext(target.identity, authorization))) {
        if (
          saved.chiMentionContext?.actor === target.identity.actor &&
          saved.chiMentionContext.repo === target.identity.repo
        )
          return { request: null, canReauthorize: true };
        throw new Error("chi-mention-context-changed");
      }
      return { request: saved, canReauthorize: false };
    },
  });
  const retry = useMutation({
    retry: false,
    mutationFn: () =>
      mentionSubmissions.retry(target.serverId, target.agentId, target.identity, target.client),
    onSettled: () => pending.refetch(),
  });
  const { mutate } = retry;
  const recover = useCallback(() => mutate(), [mutate]);
  const authorization = useMutation({
    mutationFn: () =>
      mentionSubmissions.reauthorize(target.serverId, target.agentId, target.identity),
    onSettled: () => pending.refetch(),
  });
  const { mutate: authorize } = authorization;
  const reauthorize = useCallback(() => authorize(), [authorize]);
  return (
    <View>
      {pending.isSuccess && pending.data.canReauthorize ? (
        <Button onPress={reauthorize} disabled={authorization.isPending}>
          Authorize saved send with current credentials
        </Button>
      ) : null}
      {pending.isSuccess && pending.data.request ? (
        <View>
          <Text style={styles.text}>Unconfirmed saved send: {pending.data.request.text}</Text>
          <Text style={styles.text}>
            Recipients: {pending.data.request.chiMentions?.join(", ")}. New sends are blocked until
            this exact saved send is confirmed.
          </Text>
          <Button onPress={recover} disabled={retry.isPending}>
            Retry saved send
          </Button>
        </View>
      ) : null}
      {pending.isError || retry.isError || authorization.isError ? (
        <Alert
          variant="error"
          title="Saved send requires recovery"
          description={mentionError(pending.error ?? retry.error ?? authorization.error)}
        />
      ) : null}
    </View>
  );
}

function deliveryText(status: string, error: string | null) {
  if (status === "delivered") return "Mention delivered";
  if (status === "pending") return "Mention pending — waiting for a settled capture";
  return mentionError(error);
}
const styles = StyleSheet.create((theme) => ({
  rail: { paddingHorizontal: theme.spacing[3], gap: theme.spacing[1] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
