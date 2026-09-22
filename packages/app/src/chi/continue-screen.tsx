import { useCallback, useReducer, useRef } from "react";
import { Text, View, ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { HostPicker } from "@/components/hosts/host-picker";
import { useHosts, useHostRuntimeSnapshot, type HostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useFetchQuery } from "@/data/query";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  continuationRequestId,
  clearContinuationRequest,
  currentWorkspaceCatalog,
  preparedCoordinates,
  validPreparedSelection,
} from "./continuation-state";

interface Selection {
  repo: string;
  sourceId: string;
  snapshotId: string;
  sourceHost?: string;
  agentId?: string;
  canonical?: { conversationId: string; transferId: string };
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

function selectionKey(selection: Selection, target: Target) {
  return JSON.stringify([
    selection.sourceHost,
    selection.agentId,
    selection.repo,
    selection.sourceId,
    selection.snapshotId,
    target.serverId,
    target.workspaceId,
  ]);
}

function continuationErrorMessage(message: string): string {
  const descriptions: Record<string, string> = {
    "chi-transfer-preparation-required":
      "Prepare the transfer from the source agent in Paseo before continuing.",
    "continuation-pre-mutation-failed-start-new-attempt":
      "This claimed transfer failed before native mutation. Keep its receipt for recovery on the destination host; a new request does not grant another execution.",
    "chi-session-busy": "Let the source agent finish its current turn, then retry this transfer.",
    "chi-conversation-pending":
      "This conversation is paused for a transfer. Retry the existing destination, or cancel before it claims the transfer.",
    "chi-conversation-stale":
      "This is a predecessor. Refresh source status to locate the current runtime and archive this copy.",
    "chi-conversation-recovery-required":
      "The destination claim or native mutation needs private receipt recovery on that host. Retry only the existing transfer; a new request will not create another fork.",
    "continuation-recovery-required":
      "The native mutation outcome is ambiguous. Keep the existing receipt for inspection on the selected host.",
    "chi-conversation-http-409":
      "Chi rejected this state transition. Refresh source status. A claimed transfer needs receipt recovery; late source work may have changed the selected head.",
    "chi-conversation-publication-pending":
      "The destination is registered but not published yet. Retry the existing continuation before capturing or sending a prompt.",
  };
  return descriptions[message] ?? message;
}

function SelectionHeading({
  selection,
  managed,
  valid,
  sourceMessage,
}: {
  selection: Selection;
  managed: boolean;
  valid: boolean;
  sourceMessage: string;
}) {
  let description =
    "Prepare a transfer from the source agent in Paseo before continuing. A saved evidence pin alone cannot resume a conversation.";
  if (selection.canonical)
    description = "Recover the prepared transfer on its exact destination host and workspace.";
  if (managed)
    description =
      "Pause the selected source agent, capture its latest settled work, then continue on the selected destination. Source and destination may be the same host. The published destination becomes current and the source is archived.";
  return (
    <>
      <Text style={styles.heading}>Continue conversation</Text>
      <Text style={styles.text}>{selection.repo}</Text>
      <Text style={styles.text}>
        {description} No model turn starts. Workspaces and credentials are not copied.
      </Text>
      {!valid ? (
        <Text style={styles.text}>
          {managed
            ? sourceMessage
            : "Open Continue on another host from the source agent, or use an existing prepared transfer."}
        </Text>
      ) : null}
      {managed ? (
        <Text style={styles.text}>
          Source: {selection.sourceHost} / {selection.agentId}
        </Text>
      ) : null}
    </>
  );
}

function SourceRecovery({
  selection,
  target,
  busy,
}: {
  selection: Selection;
  target: Target;
  busy: boolean;
}) {
  const runtime = useHostRuntimeSnapshot(selection.sourceHost ?? "");
  const { supported } = continuationAvailability(runtime);
  const recovery = useMutation({
    retry: false,
    mutationFn: async (action: "reconcile" | "cancel") => {
      if (!runtime?.client || !selection.agentId) throw new Error("Reconnect the source host.");
      const result = await runtime.client.manageChiConversation({
        agentId: selection.agentId,
        operation: { action },
      });
      if (result.outcome === "failed") throw new Error(result.error);
      if (action === "cancel") await clearContinuationRequest(selectionKey(selection, target));
      return result;
    },
  });
  const { mutate } = recovery;
  const cancel = useCallback(() => mutate("cancel"), [mutate]);
  const reconcile = useCallback(() => mutate("reconcile"), [mutate]);
  const disabled = busy || recovery.isPending || !supported;
  return (
    <>
      <Button variant="outline" disabled={disabled} onPress={cancel}>
        Cancel before destination claim
      </Button>
      <Button variant="outline" disabled={disabled} onPress={reconcile}>
        Refresh source / archive predecessor
      </Button>
      {recovery.data ? (
        <Text style={styles.text}>
          Current runtime: {recovery.data.current.instanceId}.{" "}
          {recovery.data.pending ? "Transfer pending." : "No pending transfer."}
        </Text>
      ) : null}
      {recovery.isError ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {continuationErrorMessage(recovery.error.message)}
        </Text>
      ) : null}
    </>
  );
}

function buttonText(pending: boolean) {
  if (pending) return "Preparing continuation…";
  return "Continue on selected destination";
}

export function ChiContinueScreen(selection: Selection) {
  const hosts = useHosts();
  const [target, dispatch] = useReducer(targetReducer, {
    serverId: "",
    workspaceId: "",
    pickerOpen: false,
  });
  const anchor = useRef<View>(null);
  const runtime = useHostRuntimeSnapshot(target.serverId);
  const client = runtime?.client;
  const sourceRuntime = useHostRuntimeSnapshot(selection.sourceHost ?? "");
  const managed = Boolean(selection.sourceHost && selection.agentId);
  const { supported, message: availabilityMessage } = continuationAvailability(runtime);
  const sourceAvailability = continuationAvailability(sourceRuntime);
  const workspaces = useFetchQuery({
    queryKey: ["chi-workspaces", target.serverId],
    enabled: Boolean(client && supported && (managed || validPreparedSelection(selection))),
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
      return { ...first, serverId: target.serverId };
    },
  });
  const valid = managed ? sourceAvailability.supported : validPreparedSelection(selection);
  const entries = currentWorkspaceCatalog(target.serverId, workspaces);
  const selectedWorkspace = entries.find((workspace) => workspace.id === target.workspaceId);
  const continuation = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!client || !supported || !valid || !selectedWorkspace)
        throw new Error("Select an available host and existing workspace.");
      const key = selectionKey(selection, target);
      const requestId = await continuationRequestId(key);
      let coordinates = {
        repo: selection.repo,
        sourceId: selection.sourceId,
        snapshotId: selection.snapshotId,
        canonical: selection.canonical,
      };
      if (managed) {
        if (!sourceRuntime?.client || !selection.agentId)
          throw new Error("Reconnect the source host.");
        const prepared = await sourceRuntime.client.manageChiConversation({
          agentId: selection.agentId,
          operation: {
            action: "prepare",
            transferId: requestId,
            destination: {
              instanceId: `${target.serverId}:opencode`,
              workspace: { hostId: target.serverId, path: selectedWorkspace.workspaceDirectory },
            },
          },
        });
        coordinates = await preparedCoordinates(prepared, key);
      }
      if (!coordinates.canonical)
        throw new Error("Prepare the transfer from the source agent before continuing.");
      const result = await client.continueChi({
        ...coordinates,
        canonical: coordinates.canonical,
        workspaceId: target.workspaceId,
        requestId,
      });
      if (result.outcome === "failed") {
        throw new Error(result.error);
      }
      if (managed && sourceRuntime?.client && selection.agentId) {
        const reconciled = await sourceRuntime.client.manageChiConversation({
          agentId: selection.agentId,
          operation: { action: "reconcile" },
        });
        if (reconciled.outcome === "failed")
          throw new Error(
            `Destination is published; source cleanup needs retry: ${reconciled.error}`,
          );
      }
      if (
        result.canonicalCurrent &&
        result.canonicalCurrent.nativeSessionId !== result.nativeSessionId
      )
        throw new Error(
          `This transfer already completed and the conversation moved again. Open the current host ${result.canonicalCurrent.instanceId}; the old incarnation remains archived.`,
        );
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
      <SelectionHeading
        selection={selection}
        managed={managed}
        valid={valid}
        sourceMessage={sourceAvailability.message}
      />
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
      {entries.map((workspace) => (
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
        disabled={!valid || !supported || !selectedWorkspace || continuation.isPending}
        onPress={submit}
      >
        {buttonText(continuation.isPending)}
      </Button>
      {managed ? (
        <SourceRecovery selection={selection} target={target} busy={continuation.isPending} />
      ) : null}
      {continuation.isError ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {continuationErrorMessage(continuation.error.message)}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function continuationAvailability(runtime: HostRuntimeSnapshot | null) {
  const supported =
    runtime?.connectionStatus === "online" &&
    runtime.client?.getLastServerInfoMessage()?.features?.chiCanonical === true;
  const message =
    runtime?.connectionStatus === "online"
      ? "Update the selected host to continue a Chi transfer."
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
