import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import { router } from "expo-router";
import { useCallback, useSyncExternalStore } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { mentionError } from "./mention-errors";
import { useMentionScope } from "./use-mention-scope";
import { readMentionSubmission, retryMentionSubmission } from "./mention-submission";
import { sameMentionContext } from "./mention-context";
import {
  mentionSelection,
  subscribeMentionSelection,
  clearMentionSelection,
} from "./mention-selection";

export function MentionDelivery({ serverId, agentId }: { serverId: string; agentId: string }) {
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
  const selected = useSyncExternalStore(
    subscribeMentionSelection,
    () => mentionSelection(serverId, agentId),
    () => mentionSelection(serverId, agentId),
  );
  const cache = useQueryClient();
  const { scope, state } = useMentionScope(serverId, workspaceId ?? "", client, supported && shared && connected && Boolean(workspaceId));
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["chi-delivery", serverId, workspaceId, agentId, connected, state.generation],
    enabled: Boolean(supported && shared && connected && client && workspaceId && state.context),
    gcTime: 0,
    retry: false,
    refetchInterval: 5000,
    queryFn: async () => {
      if (!client || !workspaceId) throw new Error("Host disconnected");
      const result = await scope.run({ action: "delivery", agentId })
        .catch((error) => {
          cache.setQueryData(["chi-delivery", serverId, workspaceId, agentId, connected], null);
          throw error;
        });
      if (result.kind !== "delivery") throw new Error("chi-invalid-response");
      return result;
    },
  });
  const retry = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!client || !workspaceId) throw new Error("Host disconnected");
      await scope.run({ action: "retry", agentId });
    },
    onSettled: () => query.refetch(),
  });
  const pending = useFetchQuery({ queryKey: ["chi-pending-send", serverId, workspaceId, agentId, state.generation], dataShape: "value", staleTimeMs: 0, gcTime: 0, retry: false, enabled: supported && connected && Boolean(state.context), refetchInterval: 2000, queryFn: () => readMentionSubmission(serverId, agentId) });
  const retrySend = useMutation({ mutationFn: async () => {
    if (!client || !state.context || !pending.data?.chiMentionContext || !sameMentionContext(state.context, pending.data.chiMentionContext)) throw new Error("chi-mention-context-changed");
    await retryMentionSubmission(serverId, agentId, client);
  }, onSettled: () => pending.refetch() });
  const { mutate: sendSaved } = retrySend;
  const recoverSend = useCallback(() => sendSaved(), [sendSaved]);
  const clear = useCallback(() => clearMentionSelection(serverId, agentId), [serverId, agentId]);
  const open = useCallback(
    () =>
      router.push({
        pathname: "/chi",
        params: { view: "inbox", host: serverId, workspace: workspaceId },
      }),
    [serverId, workspaceId],
  );
  const { mutate } = retry;
  const verify = useCallback(() => void scope.acquire().catch(() => undefined), [scope]);
  const retryDelivery = useCallback(() => mutate(), [mutate]);
  if (!supported || !workspaceId) return null;
  const deliveries =
    connected && query.isSuccess && !query.isFetching ? (query.data?.deliveries ?? []) : [];
  return (
    <View style={styles.rail}>
      {selected.length > 0 ? (
        <View>
          <Text style={styles.text}>
            Mention recipients: {selected.map((p) => `@${p.handle}`).join(", ")}
            {shared ? "" : " · Share to Chi before sending"}
          </Text>
          <Button size="sm" variant="ghost" onPress={clear}>
            Clear recipients
          </Button>
        </View>
      ) : null}
      {pending.data && state.context && pending.data.chiMentionContext && sameMentionContext(state.context, pending.data.chiMentionContext) ? <View><Text style={styles.text}>Unconfirmed saved send: {pending.data.text}</Text><Text style={styles.text}>Recipients: {pending.data.chiMentions?.join(", ")}. New sends are blocked until this exact saved send is confirmed.</Text><Button onPress={recoverSend} disabled={retrySend.isPending}>Retry saved send</Button></View> : null}
      {pending.isError || retrySend.isError ? <Alert variant="error" title="Saved send requires recovery" description={mentionError(pending.error ?? retrySend.error)} /> : null}
      <Button size="sm" variant="ghost" onPress={open}>
        Open mentions
      </Button>
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
      {state.error ? <Alert variant="error" title="Mention context unavailable" description={mentionError(state.error)}><Button onPress={verify}>Verify mention context</Button></Alert> : null}
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
