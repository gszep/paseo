import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View, ScrollView, Pressable, FlatList } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  ChiHandoff,
  ChiMentionOperation,
  ChiMentionResult,
  ChiMentionContext,
} from "@getpaseo/protocol/chi-mentions";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { FormTextInput } from "@/components/ui/form-field";
import { MenuHeader } from "@/components/headers/menu-header";
import {
  deriveDateSectionKey,
  formatDateSectionLabel,
  type DateSectionKey,
} from "@/components/date-sections";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openReplyForm } from "./reply-model";
import { mentionError } from "./mention-errors";
import { useInbox, useInboxTransport } from "./use-inbox";
import { locateMention, openMentionTarget } from "./entry-navigation";

interface InboxContext {
  identity: ChiMentionContext;
  queryKey: readonly unknown[];
  execute(operation: ChiMentionOperation): Promise<ChiMentionResult>;
}
type ListRow = { key: string; section: DateSectionKey } | { key: string; handoff: ChiHandoff };
function rowKey(row: ListRow) {
  return row.key;
}
function EmptyInbox() {
  return <Text style={styles.hint}>No mentions yet</Text>;
}
function LoadingMore() {
  return <Text style={styles.hint}>Loading more mentions…</Text>;
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

export function ChiInboxScreen() {
  const transport = useInboxTransport();
  const { scope, state, host } = transport;
  const retry = useCallback(() => void scope.acquire().catch(() => undefined), [scope]);
  const context = useMemo(
    () =>
      state.context
        ? {
            identity: state.context,
            queryKey: transport.queryKey,
            execute: (operation: ChiMentionOperation) => scope.run(operation, state.context!),
          }
        : null,
    [scope, state, transport.queryKey],
  );
  return (
    <View style={styles.screen}>
      <MenuHeader title="Mentions" />
      {!host ? (
        <Text style={styles.empty}>
          No Chi-capable host is connected. Connect a host with deployment inbox support to read
          your mentions.
        </Text>
      ) : null}
      {host && (!state.context || state.loading) && !state.error ? (
        <Text style={styles.empty}>Loading mentions…</Text>
      ) : null}
      {host && state.error && !state.loading ? (
        <Alert
          variant="error"
          title={state.accessLost ? "Mention context unavailable" : "Unable to load mentions"}
          description={mentionError(state.error)}
        >
          <Button onPress={retry}>Verify mention context</Button>
        </Alert>
      ) : null}
      {host && context && !state.loading ? (
        <Inbox key={`${host}/${state.generation}`} transport={transport} context={context} />
      ) : null}
    </View>
  );
}

function Inbox({
  transport,
  context,
}: {
  transport: ReturnType<typeof useInboxTransport>;
  context: InboxContext;
}) {
  const cache = useQueryClient();
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const [inbox, setInbox] = useState(true);
  const [selected, setSelected] = useState<ChiHandoff | null>(null);
  const [openSession, setOpenSession] = useState(true);
  const query = useInbox(transport, inbox);
  const rows = useMemo(() => {
    const result: ListRow[] = [];
    const ids = new Set<string>();
    let section: DateSectionKey | undefined;
    for (const page of query.data?.pages ?? [])
      for (const handoff of page.handoffs) {
        const key = `${handoff.repo}/${handoff.id}`;
        if (ids.has(key)) continue;
        ids.add(key);
        const next = deriveDateSectionKey(new Date(handoff.createdAt));
        if (next !== section) {
          result.push({ key: next, section: next });
          section = next;
        }
        result.push({ key, handoff });
      }
    return result;
  }, [query.data]);
  const { fetchNextPage, hasNextPage, isFetching } = query;
  const refresh = useCallback(
    () => void cache.invalidateQueries({ queryKey: context.queryKey }),
    [cache, context.queryKey],
  );
  const more = useCallback(() => {
    if (hasNextPage && !isFetching) void fetchNextPage();
  }, [hasNextPage, isFetching, fetchNextPage]);
  const switchInbox = useCallback(() => {
    setInbox(true);
    setSelected(null);
  }, []);
  const switchProject = useCallback(() => {
    setInbox(false);
    setSelected(null);
  }, []);
  const back = useCallback(() => setSelected(null), []);
  const choose = useCallback((handoff: ChiHandoff) => {
    setOpenSession(true);
    setSelected(handoff);
  }, []);
  const discuss = useCallback((handoff: ChiHandoff) => {
    setOpenSession(false);
    setSelected(handoff);
  }, []);
  const renderRow = useCallback(
    ({ item }: { item: ListRow }) =>
      "section" in item ? (
        <Text accessibilityRole="header" style={styles.section}>
          {formatDateSectionLabel(t, item.section)}
        </Text>
      ) : (
        <HandoffRow
          handoff={item.handoff}
          unread={!item.handoff.readAt && item.handoff.recipient === context.identity.actor}
          selected={selected?.id === item.handoff.id}
          onSelect={choose}
          onDiscuss={discuss}
        />
      ),
    [t, selected?.id, choose, discuss, context.identity.actor],
  );
  const refreshing = query.isFetching && !query.isFetchingNextPage;
  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Text style={styles.hint}>Signed in as @{context.identity.actor.slice(7)}</Text>
        <Button size="sm" variant="ghost" onPress={refresh}>
          Refresh
        </Button>
        <Button size="sm" variant={inbox ? "secondary" : "ghost"} onPress={switchInbox}>
          Inbox
        </Button>
        <Button size="sm" variant={inbox ? "ghost" : "secondary"} onPress={switchProject}>
          Project
        </Button>
      </View>
      {query.isError ? (
        <Alert
          variant="error"
          title="Unable to load mentions"
          description={mentionError(query.error)}
        >
          <Button onPress={refresh}>Retry</Button>
        </Alert>
      ) : null}
      {refreshing ? <Text style={styles.empty}>Refreshing mentions…</Text> : null}
      {query.data && !query.isError ? (
        <View style={compact ? styles.screen : styles.split}>
          {!compact || !selected ? (
            <FlatList
              testID="chi-flat-inbox"
              style={compact ? styles.screen : styles.list}
              contentContainerStyle={styles.content}
              data={rows}
              keyExtractor={rowKey}
              renderItem={renderRow}
              onEndReached={more}
              onEndReachedThreshold={0.5}
              ListEmptyComponent={EmptyInbox}
              ListFooterComponent={query.isFetchingNextPage ? LoadingMore : null}
            />
          ) : null}
          {selected ? (
            <View style={styles.screen}>
              <Button variant="ghost" onPress={back}>
                Back to mentions
              </Button>
              <HandoffDetail
                key={`${selected.repo}/${selected.id}/${openSession}`}
                context={context}
                selected={selected}
                openSession={openSession}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function HandoffRow({
  handoff,
  unread,
  selected,
  onSelect,
  onDiscuss,
}: {
  handoff: ChiHandoff;
  unread: boolean;
  selected: boolean;
  onSelect(h: ChiHandoff): void;
  onDiscuss(h: ChiHandoff): void;
}) {
  const choose = useCallback(() => onSelect(handoff), [handoff, onSelect]);
  const discuss = useCallback(() => onDiscuss(handoff), [handoff, onDiscuss]);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open mention ${handoff.text}`}
        onPress={choose}
        style={[styles.row, selected && styles.selected]}
      >
        <View style={styles.rowHeading}>
          <Text style={styles.text}>@{handoff.author.slice(7)}</Text>
          {unread ? (
            <View
              testID={`mention-unread-${handoff.id}`}
              accessibilityLabel="Unread mention"
              style={styles.unread}
            />
          ) : null}
        </View>
        <Text style={styles.text} numberOfLines={3}>
          {handoff.text}
        </Text>
        <Text style={styles.hint}>
          {handoff.repo.replace(/^github:/, "")} · {handoff.state} · {handoff.replies?.length ?? 0}{" "}
          replies
        </Text>
      </Pressable>
      <Button
        variant="ghost"
        size="sm"
        accessibilityLabel={`Discuss mention ${handoff.text}`}
        onPress={discuss}
      >
        Replies
      </Button>
    </View>
  );
}

function HandoffDetail({
  context,
  selected,
  openSession,
}: {
  context: InboxContext;
  selected: ChiHandoff;
  openSession: boolean;
}) {
  const cache = useQueryClient();
  const [autoOpen, setAutoOpen] = useState(openSession);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: [...context.queryKey, "handoff", selected.repo, selected.id],
    gcTime: 0,
    staleTimeMs: 0,
    retry: false,
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      const result = await context.execute({
        action: "read",
        id: selected.id,
        repo: selected.repo,
      });
      if (result.kind !== "handoff") throw new Error("chi-invalid-response");
      return result.handoff;
    },
  });
  const updated = useCallback(() => {
    setAutoOpen(false);
    void cache.invalidateQueries({ queryKey: context.queryKey });
  }, [cache, context.queryKey]);
  const { refetch } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  if (query.isFetching && !query.data) return <Text style={styles.empty}>Loading discussion…</Text>;
  if (query.isError)
    return (
      <Alert variant="error" title="Discussion unavailable" description={mentionError(query.error)}>
        <Button onPress={refresh}>Retry</Button>
      </Alert>
    );
  if (!query.data) return null;
  return (
    <Discussion context={context} handoff={query.data} autoOpen={autoOpen} onUpdated={updated} />
  );
}

function Discussion({
  context,
  handoff: h,
  autoOpen,
  onUpdated,
}: {
  context: InboxContext;
  handoff: ChiHandoff;
  autoOpen: boolean;
  onUpdated(): void;
}) {
  const cache = useQueryClient();
  const [index, setIndex] = useState(0);
  const viewed = useMutation({
    retry: false,
    mutationFn: () =>
      context.execute({ action: "viewed", repo: h.repo, id: h.id, revision: h.revision }),
    onSuccess: (result) => {
      if (result.kind !== "handoff") return;
      cache.setQueryData([...context.queryKey, "handoff", h.repo, h.id], result.handoff);
      cache.setQueriesData<InfiniteData<Extract<ChiMentionResult, { kind: "inbox" }>>>(
        { queryKey: [...context.queryKey, "inbox"] },
        (previous) =>
          previous
            ? {
                ...previous,
                pages: previous.pages.map((page) => ({
                  ...page,
                  unreadCount: Math.max(0, page.unreadCount - 1),
                  handoffs: page.handoffs.map((record) =>
                    record.repo === h.repo && record.id === h.id ? result.handoff : record,
                  ),
                })),
              }
            : previous,
      );
    },
  });
  const { mutate: markViewed, isIdle } = viewed;
  const retryRead = useCallback(() => markViewed(), [markViewed]);
  const chooseIndex = useCallback((value: string) => setIndex(Number(value)), []);
  useEffect(() => {
    if (!h.readAt && h.recipient === context.identity.actor && isIdle) markViewed();
  }, [h.readAt, h.recipient, context.identity.actor, isIdle, markViewed]);
  const canReply = h.author === context.identity.actor || h.recipient === context.identity.actor;
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.hint}>
        @{h.author.slice(7)} → @{h.recipient.slice(7)}
      </Text>
      <Text selectable style={styles.text}>
        {h.text}
      </Text>
      <Text style={styles.hint}>
        {h.state} · revision {h.revision}
      </Text>
      {viewed.isError ? (
        <Alert
          variant="info"
          title="Read status not saved"
          description={mentionError(viewed.error)}
        >
          <Button onPress={retryRead}>Retry read status</Button>
        </Alert>
      ) : null}
      {h.sources.length > 1
        ? h.sources.map((source, n) => (
            <ChoiceButton
              key={`${source.id}/${source.entryId}`}
              variant="ghost"
              value={String(n)}
              onSelect={chooseIndex}
            >
              Read exact source {n + 1}
            </ChoiceButton>
          ))
        : null}
      {h.sources[index]?.kind === "neutral" ? (
        <ExactSource key={index} context={context} handoff={h} index={index} autoOpen={autoOpen} />
      ) : (
        <Text style={styles.hint}>Exact in-app context is available for native sessions.</Text>
      )}
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
        <ReplyForm key={h.revision} handoff={h} context={context} onSuccess={onUpdated} />
      ) : null}
    </ScrollView>
  );
}

function ExactSource({
  context,
  handoff,
  index,
  autoOpen,
}: {
  context: InboxContext;
  handoff: ChiHandoff;
  index: number;
  autoOpen: boolean;
}) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [entryId, setEntryId] = useState<string | undefined>();
  const [browse, setBrowse] = useState(false);
  const [navigated, setNavigated] = useState(!autoOpen);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: [...context.queryKey, "source", handoff.repo, handoff.id, index, entryId],
    gcTime: 0,
    staleTimeMs: 0,
    retry: false,
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      const result = await context.execute({
        action: "source",
        repo: handoff.repo,
        id: handoff.id,
        index,
        entryId,
      });
      if (result.kind !== "source") throw new Error("chi-invalid-response");
      return result;
    },
  });
  const open = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!query.data) return;
      const target = await locateMention(handoff, query.data, context.identity);
      if (target && active.current) {
        await context.execute({ action: "read", repo: handoff.repo, id: handoff.id });
        if (active.current) await openMentionTarget(target);
      }
      return target;
    },
  });
  const { mutate } = open;
  useEffect(() => {
    if (!navigated && query.data && !query.isFetching) {
      setNavigated(true);
      mutate();
    }
  }, [navigated, query.data, query.isFetching, mutate]);
  const next = useCallback(() => setBrowse(true), []);
  const retry = useCallback(() => void query.refetch(), [query]);
  const continueHere = useCallback(() => {
    const source = handoff.sources[index];
    if (source?.kind === "neutral")
      router.push({
        pathname: "/chi",
        params: {
          repo: handoff.repo,
          source: source.id,
          snapshot: source.snapshot,
          sourceHost: query.data?.origin?.hostId,
          sourceSession: query.data?.origin?.sessionId,
        },
      });
  }, [handoff, index, query.data]);
  if (query.isFetching && !query.data)
    return <Text style={styles.hint}>Reading exact source…</Text>;
  if (query.isError)
    return (
      <Alert variant="error" title="Source unavailable" description={mentionError(query.error)}>
        <Button onPress={retry}>Retry source</Button>
      </Alert>
    );
  if (!query.data) return null;
  return (
    <View style={[styles.row, styles.exact]} testID="mention-exact-source">
      <Text style={styles.hint}>Exact entry: {query.data.source.entryId}</Text>
      <Text selectable style={styles.hint}>
        Snapshot: {query.data.source.kind === "neutral" ? query.data.source.snapshot : ""}
      </Text>
      <Text selectable style={styles.text}>
        {query.data.payload}
      </Text>
      {open.isPending ? <Text style={styles.hint}>Opening source session…</Text> : null}
      {open.isError ? (
        <Text style={styles.hint}>
          Could not open the connected session. The exact read-only source is shown above.
        </Text>
      ) : null}
      <Button size="sm" variant="ghost" onPress={continueHere}>
        Continue here
      </Button>
      <Text style={styles.hint}>
        Managed Continue requires the source host online to prepare a transfer, or an already
        prepared transfer. It never resumes a bare evidence pin.
      </Text>
      <Button size="sm" variant="ghost" onPress={next}>
        Browse pinned context
      </Button>
      {browse ? (
        <PinnedContext context={context} handoff={handoff} index={index} onSelect={setEntryId} />
      ) : null}
    </View>
  );
}

function PinnedContext({
  context,
  handoff,
  index,
  onSelect,
}: {
  context: InboxContext;
  handoff: ChiHandoff;
  index: number;
  onSelect(id: string): void;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: [...context.queryKey, "context", handoff.repo, handoff.id, index, cursor],
    gcTime: 0,
    staleTimeMs: 0,
    retry: false,
    queryFn: async () => {
      const result = await context.execute({
        action: "context",
        repo: handoff.repo,
        id: handoff.id,
        index,
        cursor,
      });
      if (result.kind !== "context") throw new Error("chi-invalid-response");
      return result;
    },
  });
  const nextCursor = query.data?.nextCursor;
  const next = useCallback(() => {
    if (nextCursor) setCursor(nextCursor);
  }, [nextCursor]);
  if (query.isFetching && !query.data)
    return <Text style={styles.hint}>Loading pinned context…</Text>;
  if (query.isError)
    return (
      <Alert variant="error" title="Context unavailable" description={mentionError(query.error)} />
    );
  return (
    <View>
      {query.data?.entries.map((entry) => (
        <ChoiceButton
          key={entry.nativeId}
          variant="ghost"
          value={entry.nativeId}
          onSelect={onSelect}
        >
          {entry.type}: {entry.nativeId}
        </ChoiceButton>
      ))}
      {nextCursor ? (
        <Button variant="ghost" onPress={next}>
          Next context page
        </Button>
      ) : null}
    </View>
  );
}

function ReplyForm({
  handoff,
  context,
  onSuccess,
}: {
  handoff: ChiHandoff;
  context: InboxContext;
  onSuccess(): void;
}) {
  const compact = useIsCompactFormFactor();
  const [form] = useState(() =>
    openReplyForm({
      handoff,
      context: { ...context.identity, repo: handoff.repo },
      key: `chi-reply:${JSON.stringify([context.identity.deployment, handoff.repo, context.identity.actor, handoff.id])}`,
      storage: AsyncStorage,
      execute: (operation) => {
        if (operation.action !== "reply" && operation.action !== "acknowledge")
          throw new Error("chi-invalid-operation");
        return context.execute({ ...operation, repo: handoff.repo });
      },
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
  const reauthorize = useCallback(() => void form.reauthorize().catch(() => undefined), [form]);
  const refresh = useCallback(
    () => void form.discardConflict().then((discarded) => (discarded ? onSuccess() : undefined)),
    [form, onSuccess],
  );
  return (
    <View style={styles.row}>
      {handoff.state === "open" && handoff.recipient === context.identity.actor ? (
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
      {state.status === "pending" ? <Text style={styles.hint}>Sending…</Text> : null}
      {state.status === "sent" ? <Alert variant="success" title="Reply delivered" /> : null}
      {state.status === "failed" || state.status === "blocked" ? (
        <Alert
          variant="error"
          title="Operation not confirmed"
          description={mentionError(state.error)}
        >
          {state.operation && state.status !== "blocked" ? (
            <Button variant="outline" size="sm" onPress={reply}>
              Retry saved operation
            </Button>
          ) : null}
          {state.canDiscard ? (
            <Button variant="outline" size="sm" onPress={refresh}>
              Correct rejected reply
            </Button>
          ) : null}
          {state.canReauthorize ? (
            <Button variant="outline" size="sm" onPress={reauthorize}>
              Authorize saved reply with current credentials
            </Button>
          ) : null}
        </Alert>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  split: { flex: 1, flexDirection: "row", minHeight: 0 },
  list: { width: 360, flexGrow: 0, flexShrink: 0, backgroundColor: theme.colors.surfaceSidebar },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    maxWidth: 720,
    width: "100%",
    alignSelf: "center",
  },
  empty: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  row: { padding: theme.spacing[3], gap: theme.spacing[2], borderRadius: theme.borderRadius.lg },
  rowHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  selected: { backgroundColor: theme.colors.surfaceSidebarHover },
  exact: { backgroundColor: theme.colors.surface1 },
  unread: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.accent },
  section: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    padding: theme.spacing[3],
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
