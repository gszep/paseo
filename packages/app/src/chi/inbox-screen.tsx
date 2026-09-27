import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Text, View, ScrollView, Pressable } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  ChiHandoff,
  ChiMentionOperation,
  ChiMentionResult,
} from "@getpaseo/protocol/chi-mentions";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { FormTextInput } from "@/components/ui/form-field";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { HostPicker } from "@/components/hosts/host-picker";
import { useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useIsCompactFormFactor } from "@/constants/layout";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { openReplyForm } from "./reply-model";
import { mentionError } from "./mention-errors";
import { useMentionScope } from "./use-mention-scope";

interface Target {
  host: string;
  workspace: string;
  picker: boolean;
}
type Selection =
  | { type: "host"; value: string }
  | { type: "workspace"; value: string }
  | { type: "picker"; value: boolean };
function targetReducer(state: Target, action: Selection): Target {
  if (action.type === "host") return { host: action.value, workspace: "", picker: false };
  if (action.type === "workspace") return { ...state, workspace: action.value };
  return { ...state, picker: action.value };
}
interface InboxContext {
  client: Pick<DaemonClient, "chiMentions">;
  host: string;
  workspace: string;
}

export function ChiInboxScreen({
  host = "",
  workspace = "",
}: {
  host?: string;
  workspace?: string;
}) {
  const [target, dispatch] = useReducer(targetReducer, { host, workspace, picker: false });
  const hosts = useHosts();
  const runtime = useHostRuntimeSnapshot(target.host);
  const anchor = useRef<View>(null);
  const client = runtime?.client;
  const connected = runtime?.connectionStatus === "online";
  const supported = useSessionStore(
    (state) => state.sessions[target.host]?.serverInfo?.features?.chiMentions === true,
  );
  const workspaces = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["chi-inbox-workspaces", target.host, connected],
    enabled: Boolean(client && connected),
    retry: false,
    gcTime: 0,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const first = await client.fetchWorkspaces({ page: { limit: 200 } });
      let page = first;
      const cursors = new Set<string>();
      while (page.pageInfo.hasMore) {
        const cursor = page.pageInfo.nextCursor;
        if (!cursor || cursors.has(cursor)) throw new Error("Workspace pagination failed");
        cursors.add(cursor);
        page = await client.fetchWorkspaces({ page: { limit: 200, cursor } });
        first.entries.push(...page.entries);
      }
      return first.entries;
    },
  });
  const selected =
    workspaces.isSuccess && !workspaces.isFetching && connected
      ? workspaces.data.find((w) => w.id === target.workspace)
      : undefined;
  const selectHost = useCallback((value: string) => dispatch({ type: "host", value }), []);
  const setPicker = useCallback((value: boolean) => dispatch({ type: "picker", value }), []);
  const openPicker = useCallback(() => setPicker(true), [setPicker]);
  const clearWorkspace = useCallback(() => dispatch({ type: "workspace", value: "" }), []);
  const selectWorkspace = useCallback(
    (value: string) => dispatch({ type: "workspace", value }),
    [],
  );
  const { refetch: refetchWorkspaces } = workspaces;
  const retryWorkspaces = useCallback(() => void refetchWorkspaces(), [refetchWorkspaces]);
  const openWorkspace = useCallback(() => {
    if (selected) navigateToWorkspace({ serverId: target.host, workspaceId: selected.id });
  }, [selected, target.host]);
  const title = useMemo(() => <ScreenTitle>Mentions</ScreenTitle>, []);
  const workspaceAction = useMemo(
    () =>
      selected ? (
        <Button variant="ghost" size="sm" onPress={openWorkspace}>
          Workspace
        </Button>
      ) : null,
    [selected, openWorkspace],
  );
  return (
    <View style={styles.screen}>
      <ScreenHeader left={title} right={workspaceAction} />
      <View style={styles.toolbar}>
        <HostPicker
          hosts={hosts}
          value={target.host}
          onSelect={selectHost}
          open={target.picker}
          onOpenChange={setPicker}
          anchorRef={anchor}
        >
          <View ref={anchor}>
            <Button size="sm" onPress={openPicker}>
              {hosts.find((h) => h.serverId === target.host)?.label ?? "Choose host"}
            </Button>
          </View>
        </HostPicker>
        {selected ? (
          <Button variant="ghost" size="sm" onPress={clearWorkspace}>
            {selected.name}
          </Button>
        ) : null}
      </View>
      {!connected ? (
        <Text style={styles.hint}>
          Connect your own host to use its authenticated GitHub identity
        </Text>
      ) : null}
      {workspaces.isError ? (
        <Alert variant="error" title="Unable to load workspaces">
          <Button size="sm" onPress={retryWorkspaces}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {!selected && workspaces.isSuccess && connected ? (
        <ScrollView contentContainerStyle={styles.content}>
          {workspaces.data.map((w) => (
            <ChoiceButton key={w.id} variant="ghost" value={w.id} onSelect={selectWorkspace}>
              {w.name}
            </ChoiceButton>
          ))}
        </ScrollView>
      ) : null}
      {connected && !supported ? (
        <Alert variant="info" title="Update this host to use Chi mentions" />
      ) : null}
      {selected && client && supported ? (
        <VerifiedInbox
          key={`${target.host}/${target.workspace}`}
          client={client}
          host={target.host}
          workspace={target.workspace}
        />
      ) : null}
    </View>
  );
}

function VerifiedInbox(context: { client: DaemonClient; host: string; workspace: string }) {
  const { scope, state } = useMentionScope(context.host, context.workspace, context.client, true);
  const retry = useCallback(() => void scope.acquire().catch(() => undefined), [scope]);
  const client = useMemo(() => ({ chiMentions: (input: Parameters<DaemonClient["chiMentions"]>[0]) => scope.run(input.operation) }), [scope]);
  if (!state.context) return <Alert variant="error" title="Mention context unavailable" description={state.error ? mentionError(state.error) : "Verifying account and repository..."}><Button onPress={retry}>Verify mention context</Button></Alert>;
  return <Inbox key={state.generation} host={context.host} workspace={context.workspace} client={client} />;
}

function ChoiceButton({
  value,
  onSelect,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "onPress"> & {
  value: string;
  onSelect(value: string): void;
}) {
  const choose = useCallback(() => onSelect(value), [onSelect, value]);
  return <Button {...props} onPress={choose} />;
}

function Inbox(context: InboxContext) {
  const cache = useQueryClient();
  const [selection, select] = useReducer(
    (
      state: { inbox: boolean; id: string | null; offset: number },
      action:
        | { type: "select"; id: string | null }
        | { type: "view"; inbox: boolean }
        | { type: "page"; offset: number },
    ) => {
      if (action.type === "select") return { ...state, id: action.id };
      if (action.type === "view") return { inbox: action.inbox, id: null, offset: 0 };
      return { ...state, offset: action.offset, id: null };
    },
    { inbox: true, id: null, offset: 0 },
  );
  const compact = useIsCompactFormFactor();
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["chi-inbox", context.host, context.workspace, selection.inbox, selection.offset],
    retry: false,
    gcTime: 0,
    staleTimeMs: 0,
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      const result = await context.client
        .chiMentions({
          workspaceId: context.workspace,
          operation: { action: "list", inbox: selection.inbox, offset: selection.offset },
        })
        .catch((error) => {
          cache.setQueryData(
            ["chi-inbox", context.host, context.workspace, selection.inbox, selection.offset],
            null,
          );
          throw error;
        });
      if (result.kind !== "list") throw new Error("chi-invalid-response");
      return result;
    },
  });
  const { refetch } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  const inbox = useCallback(() => select({ type: "view", inbox: true }), []);
  const project = useCallback(() => select({ type: "view", inbox: false }), []);
  const choose = useCallback((id: string) => select({ type: "select", id }), []);
  const back = useCallback(() => select({ type: "select", id: null }), []);
  const previous = useCallback(
    () => select({ type: "page", offset: Math.max(0, selection.offset - 50) }),
    [selection.offset],
  );
  const nextOffset = query.data?.nextOffset;
  const next = useCallback(() => {
    if (nextOffset != null) select({ type: "page", offset: nextOffset });
  }, [nextOffset]);
  if (query.isFetching) return <Text style={styles.hint}>Refreshing mentions...</Text>;
  if (query.isError)
    return (
      <Alert
        variant="error"
        title="Unable to load mentions"
        description={mentionError(query.error)}
      >
        <Button size="sm" onPress={refresh}>
          Retry
        </Button>
      </Alert>
    );
  if (!query.isSuccess || !query.data) return <Text style={styles.hint}>Loading mentions...</Text>;
  const showList = !compact || !selection.id;
  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Text style={styles.hint}>Signed in as @{query.data.actor.slice(7)}</Text>
        <Button size="sm" variant="ghost" onPress={refresh}>
          Refresh
        </Button>
        <Button size="sm" variant={selection.inbox ? "secondary" : "ghost"} onPress={inbox}>
          Inbox
        </Button>
        <Button size="sm" variant={selection.inbox ? "ghost" : "secondary"} onPress={project}>
          Project
        </Button>
      </View>
      <View style={compact ? styles.compact : styles.split}>
        {showList ? (
          <ScrollView
            style={compact ? styles.screen : styles.list}
            contentContainerStyle={styles.content}
          >
            {query.data.handoffs.length === 0 ? (
              <Text style={styles.hint}>No mentions yet</Text>
            ) : null}
            {query.data.handoffs.map((h) => (
              <HandoffRow
                key={h.id}
                handoff={h}
                selected={selection.id === h.id}
                onSelect={choose}
              />
            ))}
            {selection.offset > 0 ? (
              <Button size="sm" variant="ghost" onPress={previous}>
                Previous page
              </Button>
            ) : null}
            {query.data.nextOffset !== null ? (
              <Button size="sm" variant="ghost" onPress={next}>
                Next page
              </Button>
            ) : null}
          </ScrollView>
        ) : null}
        {selection.id ? (
          <View style={styles.screen}>
            {compact ? (
              <Button variant="ghost" onPress={back}>
                Back to mentions
              </Button>
            ) : null}
            <HandoffDetail
              key={`${selection.id}/${query.data.actor}`}
              {...context}
              id={selection.id}
            />
          </View>
        ) : null}
        {!selection.id && !compact ? <Text style={styles.hint}>Select a mention</Text> : null}
      </View>
    </View>
  );
}

function HandoffRow({
  handoff: h,
  selected,
  onSelect,
}: {
  handoff: ChiHandoff;
  selected: boolean;
  onSelect(id: string): void;
}) {
  const choose = useCallback(() => onSelect(h.id), [onSelect, h.id]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open mention ${h.text}`}
      onPress={choose}
      style={[styles.row, selected && styles.selected]}
    >
      <Text style={styles.text}>
        @{h.author.slice(7)} → @{h.recipient.slice(7)}
      </Text>
      <Text style={styles.text} numberOfLines={3}>
        {h.text}
      </Text>
      <Text style={styles.hint}>
        {h.state} · {h.replies?.length ?? 0} replies
      </Text>
    </Pressable>
  );
}

function HandoffDetail(context: InboxContext & { id: string }) {
  const queryClient = useQueryClient();
  const [sourceIndex, setSourceIndex] = useState<number | null>(null);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["chi-handoff", context.host, context.workspace, context.id],
    gcTime: 0,
    staleTimeMs: 0,
    retry: false,
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      const result = await context.client
        .chiMentions({
          workspaceId: context.workspace,
          operation: { action: "read", id: context.id },
        })
        .catch((error) => {
          queryClient.setQueryData(
            ["chi-handoff", context.host, context.workspace, context.id],
            null,
          );
          throw error;
        });
      if (result.kind !== "handoff") throw new Error("chi-invalid-response");
      return result;
    },
  });
  const updated = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["chi-inbox", context.host, context.workspace],
    });
  }, [queryClient, context.host, context.workspace]);
  const { refetch } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  const chooseSource = useCallback((index: string) => setSourceIndex(Number(index)), []);
  if (query.isFetching) return <Text style={styles.hint}>Refreshing discussion...</Text>;
  if (query.isError)
    return (
      <Alert variant="error" title="Discussion unavailable" description={mentionError(query.error)}>
        <Button size="sm" onPress={refresh}>
          Retry
        </Button>
      </Alert>
    );
  if (!query.isSuccess || !query.data) return null;
  const h = query.data.handoff;
  const canReply = h.author === query.data.actor || h.recipient === query.data.actor;
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.text}>
        @{h.author.slice(7)} → @{h.recipient.slice(7)}
      </Text>
      <Text selectable style={styles.text}>
        {h.text}
      </Text>
      <Text style={styles.hint}>
        {h.state} · revision {h.revision}
      </Text>
      {h.sources.map((source, index) => (
        <ChoiceButton
          key={`${source.kind}/${source.id}/${source.entryId}`}
          variant="outline"
          size="sm"
          disabled={source.kind !== "neutral"}
          value={String(index)}
          onSelect={chooseSource}
        >
          Read exact source {index + 1}
        </ChoiceButton>
      ))}
      {sourceIndex !== null ? (
        <ExactSource key={`${context.id}/${sourceIndex}`} {...context} index={sourceIndex} />
      ) : null}
      {h.resolution ? (
        <Text style={styles.text}>
          {h.resolution.incomplete ? "Incomplete outcome: " : "Resolution: "}
          {h.resolution.text}
        </Text>
      ) : null}
      {(h.replies ?? []).map((reply) => (
        <View key={reply.id} style={styles.row}>
          <Text style={styles.hint}>
            @{reply.actor.slice(7)} · {reply.at}
          </Text>
          <Text selectable style={styles.text}>
            {reply.text}
          </Text>
        </View>
      ))}
      {canReply ? (
        <ReplyForm
          key={`${h.id}/${h.revision}`}
          handoff={h}
          actor={query.data.actor}
          context={context}
          onSuccess={updated}
        />
      ) : null}
    </ScrollView>
  );
}

function ExactSource(context: InboxContext & { id: string; index: number }) {
  const cache = useQueryClient();
  const [selection, select] = useReducer(
    (
      state: { entryId?: string; browse: boolean },
      action: { type: "entry"; entryId: string } | { type: "browse" },
    ) =>
      action.type === "entry" ? { ...state, entryId: action.entryId } : { ...state, browse: true },
    { browse: false },
  );
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: [
      "chi-source",
      context.host,
      context.workspace,
      context.id,
      context.index,
      selection.entryId,
    ],
    gcTime: 0,
    staleTimeMs: 0,
    retry: false,
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      const result = await context.client
        .chiMentions({
          workspaceId: context.workspace,
          operation: {
            action: "source",
            id: context.id,
            index: context.index,
            entryId: selection.entryId,
          },
        })
        .catch((error) => {
          cache.setQueryData(
            [
              "chi-source",
              context.host,
              context.workspace,
              context.id,
              context.index,
              selection.entryId,
            ],
            null,
          );
          throw error;
        });
      if (result.kind !== "source") throw new Error("chi-invalid-response");
      return result;
    },
  });
  const { refetch } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  const browse = useCallback(() => select({ type: "browse" }), []);
  const choose = useCallback((entryId: string) => select({ type: "entry", entryId }), []);
  if (query.isFetching) return <Text style={styles.hint}>Reading exact source...</Text>;
  if (query.isError)
    return (
      <Alert variant="error" title="Source unavailable" description={mentionError(query.error)}>
        <Button size="sm" onPress={refresh}>
          Retry source
        </Button>
      </Alert>
    );
  if (!query.isSuccess || !query.data) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.hint}>Exact entry: {query.data.source.entryId}</Text>
      <Text selectable style={styles.hint}>
        Snapshot: {query.data.source.kind === "neutral" ? query.data.source.snapshot : ""}
      </Text>
      <Text selectable style={styles.text}>
        {query.data.payload}
      </Text>
      <Button size="sm" variant="ghost" onPress={browse}>
        Browse pinned context
      </Button>
      {selection.browse ? <PinnedContext {...context} onSelect={choose} /> : null}
    </View>
  );
}

function PinnedContext(
  context: InboxContext & { id: string; index: number; onSelect(entryId: string): void },
) {
  const cache = useQueryClient();
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["chi-context", context.host, context.workspace, context.id, context.index, cursor],
    gcTime: 0,
    staleTimeMs: 0,
    retry: false,
    queryFn: async () => {
      const result = await context.client
        .chiMentions({
          workspaceId: context.workspace,
          operation: { action: "context", id: context.id, index: context.index, cursor },
        })
        .catch((error) => {
          cache.setQueryData(
            ["chi-context", context.host, context.workspace, context.id, context.index, cursor],
            null,
          );
          throw error;
        });
      if (result.kind !== "context") throw new Error("chi-invalid-response");
      return result;
    },
  });
  const { refetch } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  const nextCursor = query.data?.nextCursor;
  const next = useCallback(() => {
    if (nextCursor) setCursor(nextCursor);
  }, [nextCursor]);
  const first = useCallback(() => setCursor(undefined), []);
  if (query.isFetching) return <Text style={styles.hint}>Loading pinned context...</Text>;
  if (query.isError)
    return (
      <Alert variant="error" title="Context unavailable" description={mentionError(query.error)}>
        <Button size="sm" onPress={refresh}>
          Retry context
        </Button>
      </Alert>
    );
  if (!query.isSuccess || !query.data) return null;
  return (
    <View style={styles.row}>
      {query.data.entries.map((entry) => (
        <ChoiceButton
          key={entry.nativeId}
          variant="ghost"
          size="sm"
          value={entry.nativeId}
          onSelect={context.onSelect}
        >
          {entry.type}: {entry.nativeId}
        </ChoiceButton>
      ))}
      {query.data.nextCursor ? (
        <Button variant="ghost" size="sm" onPress={next}>
          Next context page
        </Button>
      ) : null}
      {cursor ? (
        <Button variant="ghost" size="sm" onPress={first}>
          First context page
        </Button>
      ) : null}
    </View>
  );
}

function ReplyForm({
  handoff,
  actor,
  context,
  onSuccess,
}: {
  handoff: ChiHandoff;
  actor: string;
  context: InboxContext;
  onSuccess(handoff: ChiHandoff): void;
}) {
  const compact = useIsCompactFormFactor();
  const [form] = useState(() =>
    openReplyForm({
      handoff,
      key: `chi-reply:${JSON.stringify([context.host, context.workspace, actor, handoff.id])}`,
      storage: AsyncStorage,
      execute: (operation: ChiMentionOperation): Promise<ChiMentionResult> =>
        context.client.chiMentions({ workspaceId: context.workspace, operation }),
      uuid: () => crypto.randomUUID(),
      onSuccess,
    }),
  );
  useEffect(() => () => form.close(), [form]);
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const locked =
    state.status === "loading" ||
    state.status === "blocked" ||
    state.status === "pending" ||
    state.operation !== null;
  const acknowledge = useCallback(() => void form.send("acknowledge"), [form]);
  const reply = useCallback(() => void form.send("reply"), [form]);
  const refresh = useCallback(
    () => void form.discardConflict().then(() => onSuccess(handoff)),
    [form, onSuccess, handoff],
  );
  return (
    <View style={styles.row}>
      {handoff.state === "open" && handoff.recipient === actor ? (
        <Button size="sm" variant="outline" disabled={locked} onPress={acknowledge}>
          Acknowledge
        </Button>
      ) : null}
      {state.status !== "loading" ? (
        <FormTextInput
          key={state.status === "sent" ? "sent" : "draft"}
          initialValue={state.text}
          accessibilityLabel="Reply to mention"
          placeholder="Reply"
          multiline
          size={compact ? "md" : "sm"}
          editable={!locked}
          onChangeText={form.setText}
        />
      ) : null}
      <Button size="sm" disabled={locked || !state.text.trim()} onPress={reply}>
        Send reply
      </Button>
      {state.status === "pending" ? <Text style={styles.hint}>Sending...</Text> : null}
      {state.status === "sent" ? <Alert variant="success" title="Reply delivered" /> : null}
      {state.status === "failed" || state.status === "blocked" ? (
        <Alert
          variant="error"
          title="Operation not confirmed"
          description={mentionError(state.error)}
        >
          {state.operation ? (
            <Button variant="outline" size="sm" onPress={reply}>
              Retry saved operation
            </Button>
          ) : null}
          {state.error === "chi-mentions-http-409" ? (
            <Button variant="outline" size="sm" onPress={refresh}>
              Refresh discussion
            </Button>
          ) : null}
        </Alert>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  split: { flex: 1, flexDirection: "row", minHeight: 0 },
  compact: { flex: 1, minHeight: 0 },
  list: { width: 320, flexGrow: 0, flexShrink: 0, backgroundColor: theme.colors.surfaceSidebar },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    maxWidth: 720,
    width: "100%",
    alignSelf: "center",
  },
  row: { padding: theme.spacing[3], gap: theme.spacing[2], borderRadius: theme.borderRadius.lg },
  selected: { backgroundColor: theme.colors.surfaceSidebarHover },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
