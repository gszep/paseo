import { useCallback, useReducer, useRef } from "react";
import { Text, View, ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { HostPicker } from "@/components/hosts/host-picker";
import { useHosts, useHostRuntimeSnapshot, type HostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useFetchQuery } from "@/data/query";
import { navigateToAgent } from "@/utils/navigate-to-agent";

interface Selection {
  repo: string;
  sourceId: string;
  snapshotId: string;
}
interface Target {
  serverId: string;
  workspaceId: string;
  pickerOpen: boolean;
}
type Action =
  | { type: "host"; value: string }
  | { type: "workspace"; value: string }
  | { type: "picker"; open: boolean };
function targetReducer(state: Target, action: Action): Target {
  if (action.type === "host") return { serverId: action.value, workspaceId: "", pickerOpen: false };
  if (action.type === "workspace") return { ...state, workspaceId: action.value };
  return { ...state, pickerOpen: action.open };
}

export function ChiContinueScreen(selection: Selection) {
  const hosts = useHosts();
  const [target, dispatch] = useReducer(targetReducer, {
    serverId: "",
    workspaceId: "",
    pickerOpen: false,
  });
  const anchor = useRef<View>(null);
  const receiptIds = useRef(new Map<string, string>());
  const runtime = useHostRuntimeSnapshot(target.serverId);
  const client = runtime?.client;
  const { supported, message: availabilityMessage } = continuationAvailability(runtime);
  const workspaces = useFetchQuery({
    queryKey: ["chi-workspaces", target.serverId],
    enabled: Boolean(client && supported),
    retry: false,
    dataShape: "list",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client) throw new Error("The selected host is disconnected.");
      const first = await client.fetchWorkspaces({ page: { limit: 200 } });
      const cursors = new Set<string>();
      let page = first;
      while (page.pageInfo.hasMore) {
        const cursor = page.pageInfo.nextCursor;
        if (!cursor || cursors.has(cursor))
          throw new Error("Workspace pagination did not complete.");
        cursors.add(cursor);
        page = await client.fetchWorkspaces({ page: { limit: 200, cursor } });
        first.entries.push(...page.entries);
      }
      return first;
    },
  });
  const valid = validSelection(selection);
  const continuation = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!client || !supported || !valid || !target.workspaceId)
        throw new Error("Select an available host and existing workspace.");
      const key = `${target.serverId}/${target.workspaceId}`;
      let requestId = receiptIds.current.get(key);
      if (!requestId) {
        requestId = crypto.randomUUID();
        receiptIds.current.set(key, requestId);
      }
      const result = await client.continueChi({
        ...selection,
        workspaceId: target.workspaceId,
        requestId,
      });
      if (result.outcome === "failed") throw new Error(result.error);
      return { result, serverId: target.serverId, workspaceId: target.workspaceId };
    },
    onSuccess: ({ result, serverId, workspaceId }) =>
      navigateToAgent({
        serverId,
        workspaceId,
        agentId: result.agent.id,
      }),
  });
  const selectHost = useCallback((value: string) => dispatch({ type: "host", value }), []);
  const selectWorkspace = useCallback(
    (value: string) => dispatch({ type: "workspace", value }),
    [],
  );
  const setPicker = useCallback((open: boolean) => dispatch({ type: "picker", open }), []);
  const openPicker = useCallback(() => setPicker(true), [setPicker]);
  const { mutate } = continuation;
  const submit = useCallback(() => mutate(), [mutate]);
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.heading}>Continue in Paseo</Text>
      <Text style={styles.text}>{selection.repo}</Text>
      <Text style={styles.text}>
        Fork the whole selected Chi snapshot into this host’s OpenCode runtime. No model turn
        starts. Future settled turns of the fork are captured to Chi.
      </Text>
      {!valid ? <Text style={styles.text}>Invalid Chi evidence coordinates.</Text> : null}
      <HostPicker
        hosts={hosts}
        value={target.serverId}
        onSelect={selectHost}
        open={target.pickerOpen}
        onOpenChange={setPicker}
        anchorRef={anchor}
      >
        <View ref={anchor}>
          <Button disabled={continuation.isPending} onPress={openPicker}>
            {hosts.find((host) => host.serverId === target.serverId)?.label ?? "Choose host"}
          </Button>
        </View>
      </HostPicker>
      {target.serverId && !supported ? (
        <Text style={styles.text}>{availabilityMessage}</Text>
      ) : null}
      {workspaces.isFetching ? <Text style={styles.text}>Loading workspaces…</Text> : null}
      {workspaces.isError ? (
        <Text style={styles.text}>Could not load this host’s workspaces.</Text>
      ) : null}
      {workspaces.data?.entries.map((workspace) => (
        <WorkspaceChoice
          key={workspace.id}
          id={workspace.id}
          name={workspace.name}
          selected={target.workspaceId === workspace.id}
          disabled={continuation.isPending}
          onSelect={selectWorkspace}
        />
      ))}
      <Button
        disabled={!valid || !supported || !target.workspaceId || continuation.isPending}
        onPress={submit}
      >
        {continuation.isPending ? "Preparing native fork…" : "Fork selected snapshot"}
      </Button>
      {continuation.isError ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {continuation.error.message}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function validSelection(selection: Selection): boolean {
  return (
    /^github:[^/\s]+\/[^/\s]+$/.test(selection.repo) &&
    /^[a-f0-9]{64}$/.test(selection.sourceId) &&
    /^[a-f0-9]{64}$/.test(selection.snapshotId)
  );
}

function continuationAvailability(runtime: HostRuntimeSnapshot | null) {
  const supported =
    runtime?.connectionStatus === "online" &&
    runtime.client?.getLastServerInfoMessage()?.features?.chiNative === true;
  const message =
    runtime?.connectionStatus === "online"
      ? "Update the selected host to use Chi native continuation."
      : "Reconnect the selected host before continuing.";
  return { supported, message };
}

function WorkspaceChoice({
  id,
  name,
  selected,
  disabled,
  onSelect,
}: {
  id: string;
  name: string;
  selected: boolean;
  disabled: boolean;
  onSelect(id: string): void;
}) {
  const select = useCallback(() => onSelect(id), [id, onSelect]);
  return (
    <Button variant={selected ? "default" : "outline"} disabled={disabled} onPress={select}>
      {name}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    maxWidth: 720,
    width: "100%",
    alignSelf: "center",
  },
  heading: { color: theme.colors.foreground, fontSize: 22, fontWeight: "600" },
  text: { color: theme.colors.foreground },
}));
