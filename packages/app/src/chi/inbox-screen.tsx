import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Text,
  View,
  ScrollView,
  Pressable,
  FlatList,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MessageSquare } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { router, useFocusEffect } from "expo-router";
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
import { SearchField } from "@/components/ui/search-field";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
import { formatDateSectionLabel } from "@/components/date-sections";
import { formatTimeAgo } from "@/utils/time";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openReplyForm } from "./reply-model";
import { readHumanPrompts } from "@getpaseo/protocol/chi-mentions";
import { mentionError } from "./mention-errors";
import { useInbox, useInboxTransport } from "./use-inbox";
import { locateMention, openMentionTarget } from "./entry-navigation";
import { RepositoryFilter } from "./repository-filter";
import { inboxDetailQueryOptions } from "./inbox-query";
import {
  ALL_REPOSITORIES_OPTION_ID,
  buildInboxRows,
  filterInboxHandoffs,
  inboxRepositories,
  repositoryLabel,
  type InboxListRow,
} from "./inbox-model";

interface InboxContext {
  identity: ChiMentionContext;
  queryKey: readonly unknown[];
  execute(operation: ChiMentionOperation): Promise<ChiMentionResult>;
  isCurrent(): boolean;
}
function rowKey(row: InboxListRow) {
  return row.key;
}
function EmptyInbox({ filtered }: { filtered: boolean }) {
  return <Text style={styles.hint}>{filtered ? "No mentions match" : "No mentions yet"}</Text>;
}
function LoadingMore() {
  return <Text style={styles.hint}>Loading more mentions…</Text>;
}

const ThemedMessageSquare = withUnistyles(MessageSquare);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
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
            isCurrent: () =>
              scope.getState().generation === state.generation &&
              scope.getState().context === state.context,
          }
        : null,
    [scope, state, transport.queryKey],
  );
  return (
    <View style={styles.screen}>
      <MenuHeader title="Mentions" />
      {!host ? (
        <Text style={styles.empty}>
          {transport.verifying
            ? "Verifying your Chi inbox account…"
            : transport.transportError ||
              "No Chi-capable host is connected. Connect a host with deployment inbox support to read your mentions."}
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
  const [searchInput, setSearchInput] = useState("");
  const [repository, setRepository] = useState(ALL_REPOSITORIES_OPTION_ID);
  const [selected, setSelected] = useState<ChiHandoff | null>(null);
  const [openSession, setOpenSession] = useState(true);
  // A unified list: the backend returns every handoff this principal can read
  // (received and authored), which is what the flat History-style view shows.
  const query = useInbox(transport, false);
  const loaded = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.handoffs),
    [query.data],
  );
  const repositories = useMemo(() => inboxRepositories(loaded), [loaded]);
  const filtered = useMemo(
    () => filterInboxHandoffs(loaded, { search: searchInput, repository }),
    [loaded, searchInput, repository],
  );
  const rows = useMemo(() => buildInboxRows(filtered), [filtered]);
  const { fetchNextPage, hasNextPage, isFetching, refetch } = query;
  const refresh = useCallback(
    () => void cache.invalidateQueries({ queryKey: context.queryKey }),
    [cache, context.queryKey],
  );
  // Open/route focus refresh. Window focus and reconnect are handled by the
  // query's own refetch options; this covers returning from a detail view.
  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch]),
  );
  const more = useCallback(() => {
    if (hasNextPage && !isFetching) void fetchNextPage();
  }, [hasNextPage, isFetching, fetchNextPage]);
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
    ({ item }: { item: InboxListRow }) =>
      "section" in item ? (
        <Text accessibilityRole="header" style={styles.section}>
          {formatDateSectionLabel(t, item.section)}
        </Text>
      ) : (
        <InboxRow
          handoff={item.handoff}
          search={searchInput}
          unread={!item.handoff.readAt && item.handoff.recipient === context.identity.actor}
          selected={selected?.id === item.handoff.id}
          onSelect={choose}
          onDiscuss={discuss}
        />
      ),
    [t, searchInput, selected?.id, choose, discuss, context.identity.actor],
  );
  const isFiltered = searchInput.trim().length > 0 || repository !== ALL_REPOSITORIES_OPTION_ID;
  const repositoryOptionTestID = useCallback((id: string) => `inbox-repo-filter-item-${id}`, []);
  const emptyComponent = useMemo(() => <EmptyInbox filtered={isFiltered} />, [isFiltered]);
  const refreshing = query.isFetching && !query.isFetchingNextPage;
  return (
    <View style={styles.screen}>
      <View style={styles.filterRail}>
        <View style={styles.filterRow}>
          <SearchField
            value={searchInput}
            onChangeText={setSearchInput}
            placeholder="Search mentions"
            clearAccessibilityLabel="Clear mention search"
            testID="inbox-search-input"
            clearTestID="inbox-search-clear"
          />
          <RepositoryFilter
            repositories={repositories}
            selected={repository}
            onSelect={setRepository}
            triggerTestID="inbox-repo-filter-trigger"
            optionTestID={repositoryOptionTestID}
          />
        </View>
        <Text style={styles.identity} testID="inbox-identity">
          Signed in as @{context.identity.actor.slice(7)}
        </Text>
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
              contentContainerStyle={styles.listContent}
              data={rows}
              keyExtractor={rowKey}
              renderItem={renderRow}
              onEndReached={more}
              onEndReachedThreshold={0.5}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={emptyComponent}
              ListFooterComponent={query.isFetchingNextPage ? LoadingMore : null}
              extraData={isFiltered}
            />
          ) : null}
          {selected ? (
            <View style={styles.screen}>
              <View style={styles.detailHeader}>
                <Button variant="ghost" onPress={back}>
                  Back to mentions
                </Button>
              </View>
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

/** One Mentions row, laid out on the History agent-row rails. */
function InboxRow({
  handoff,
  search,
  unread,
  selected,
  onSelect,
  onDiscuss,
}: {
  handoff: ChiHandoff;
  search: string;
  unread: boolean;
  selected: boolean;
  onSelect(h: ChiHandoff): void;
  onDiscuss(h: ChiHandoff): void;
}) {
  const compact = useIsCompactFormFactor();
  const handle = `@${handoff.author.slice(7)}`;
  const repo = repositoryLabel(handoff.repo);
  const replies = handoff.replies?.length ?? 0;
  const timeAgo = formatTimeAgo(new Date(handoff.createdAt));
  const ranges = useMemo(
    () => ({
      handle: findHighlightRanges(search, handle),
      repo: findHighlightRanges(search, repo),
      text: findHighlightRanges(search, handoff.text),
    }),
    [search, handle, repo, handoff.text],
  );

  const choose = useCallback(() => onSelect(handoff), [handoff, onSelect]);
  const discuss = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      onDiscuss(handoff);
    },
    [handoff, onDiscuss],
  );
  const pressableStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.rowPress,
      selected && styles.rowSelected,
      Boolean(hovered) && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [selected],
  );

  return (
    <View style={styles.rowFrame} testID={`mention-row-${handoff.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open mention ${handoff.text}`}
        onPress={choose}
        style={pressableStyle}
      >
        <View style={styles.rowContent}>
          <View style={styles.rowTitleRow}>
            <HighlightedText
              text={handle}
              ranges={ranges.handle}
              style={styles.rowHandle}
              numberOfLines={1}
            />
            {unread ? (
              <View
                testID={`mention-unread-${handoff.id}`}
                accessibilityLabel="Unread mention"
                style={styles.unread}
              />
            ) : null}
            <Text style={styles.rowState}>{handoff.state}</Text>
          </View>
          {compact ? (
            <View style={styles.rowMetaRow}>
              <HighlightedText
                text={repo}
                ranges={ranges.repo}
                style={styles.rowMetaText}
                numberOfLines={1}
              />
              <Text style={styles.rowMetaSeparator}>·</Text>
              <Text style={styles.rowMetaText}>{replies} replies</Text>
              <Text style={styles.rowMetaSeparator}>·</Text>
              <Text style={styles.rowMetaText}>{timeAgo}</Text>
            </View>
          ) : (
            <HighlightedText
              text={handoff.text}
              ranges={ranges.text}
              style={styles.rowSnippet}
              numberOfLines={1}
            />
          )}
        </View>
        {!compact ? (
          <View style={styles.rowColumns}>
            <HighlightedText
              text={repo}
              ranges={ranges.repo}
              style={styles.columnMeta}
              numberOfLines={1}
            />
            <Text style={styles.columnMetaReplies} numberOfLines={1}>
              {replies} replies
            </Text>
            <Text style={styles.columnMetaFixed} numberOfLines={1}>
              {timeAgo}
            </Text>
          </View>
        ) : null}
      </Pressable>
      <Pressable
        onPress={discuss}
        accessibilityRole="button"
        accessibilityLabel={`Discuss mention ${handoff.text}`}
        hitSlop={8}
        style={styles.rowDiscuss}
        testID={`mention-replies-${handoff.id}`}
      >
        <ThemedMessageSquare size={14} uniProps={mutedIconMapping} />
      </Pressable>
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
  const query = useFetchQuery(
    inboxDetailQueryOptions({
      queryKey: context.queryKey,
      repo: selected.repo,
      id: selected.id,
      run: context.execute,
    }),
  );
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
  const prompts = readHumanPrompts(h.text);
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.hint}>
        @{h.author.slice(7)} → @{h.recipient.slice(7)}
      </Text>
      <Text selectable style={styles.text}>
        {prompts
          ? `Agent-initiated · ${prompts.sessionId} · ${prompts.turnId}\n${prompts.items.map((item) => `${item.kind}: ${item.text}`).join("\n\n")}`
          : h.text}
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
  const lifetime = useRef({ generation: 0, active: false });
  useFocusEffect(
    useCallback(() => {
      lifetime.current = { generation: lifetime.current.generation + 1, active: true };
      return () => {
        lifetime.current = { generation: lifetime.current.generation + 1, active: false };
      };
    }, []),
  );
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
      const started = lifetime.current.generation;
      const isCurrent = () =>
        lifetime.current.active && lifetime.current.generation === started && context.isCurrent();
      if (!isCurrent()) return;
      const target = await locateMention(handoff, query.data, context.identity);
      if (target && isCurrent()) {
        await context.execute({ action: "read", repo: handoff.repo, id: handoff.id });
        if (isCurrent()) await openMentionTarget(target, isCurrent);
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

function HumanPromptControl({
  handoff,
  context,
  onSuccess,
  control,
}: {
  handoff: ChiHandoff;
  context: InboxContext;
  onSuccess(): void;
  control: "mute" | "snooze";
}) {
  const [form] = useState(() =>
    openReplyForm({
      handoff,
      context: { ...context.identity, repo: handoff.repo },
      key: `chi-reply:${JSON.stringify([context.identity.deployment, handoff.repo, context.identity.actor, handoff.id])}`,
      storage: AsyncStorage,
      control,
      confirmMute: () =>
        confirmDialog({
          title: "Mute prompts from this session?",
          message:
            "This permanently stops new human prompts from this session. You cannot undo this mute.",
          confirmLabel: "Mute prompts",
          destructive: true,
        }),
      execute: (operation) => {
        if (operation.action !== "reply") throw new Error("chi-invalid-operation");
        return context.execute({ ...operation, repo: handoff.repo });
      },
      uuid: () => crypto.randomUUID(),
      onSuccess,
    }),
  );
  useEffect(() => () => form.close(), [form]);
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const send = useCallback(() => void form.send("reply"), [form]);
  const reauthorize = useCallback(() => void form.reauthorize(), [form]);
  const discard = useCallback(
    () =>
      void form.discardConflict().then((changed) => {
        return changed ? onSuccess() : undefined;
      }),
    [form, onSuccess],
  );
  const label = control === "mute" ? "Mute prompts from this session" : "Snooze prompts for 1 hour";
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={
          state.status === "loading" ||
          state.status === "blocked" ||
          state.status === "pending" ||
          state.status === "sent"
        }
        onPress={send}
      >
        {state.operation ? `Retry ${control}` : label}
      </Button>
      {state.status === "pending" ? (
        <Text style={styles.hint}>
          {control === "mute" ? "Muting prompts…" : "Snoozing prompts…"}
        </Text>
      ) : null}
      {state.status === "sent" ? (
        <Alert
          variant="success"
          title={
            control === "mute" ? "Prompts muted for this session" : "Prompts snoozed for 1 hour"
          }
        />
      ) : null}
      {state.status === "failed" || state.status === "blocked" ? (
        <Alert
          variant="error"
          title={`${control === "mute" ? "Mute" : "Snooze"} not confirmed`}
          description={mentionError(state.error)}
        >
          {state.canDiscard ? (
            <Button size="sm" variant="outline" onPress={discard}>
              Refresh rejected {control}
            </Button>
          ) : null}
          {state.canReauthorize ? (
            <Button size="sm" variant="outline" onPress={reauthorize}>
              Authorize saved {control} with current credentials
            </Button>
          ) : null}
        </Alert>
      ) : null}
    </>
  );
}

function HumanPromptControls(props: {
  handoff: ChiHandoff;
  context: InboxContext;
  onSuccess(): void;
}) {
  if (
    !readHumanPrompts(props.handoff.text) ||
    props.handoff.humanPromptControls !== true ||
    props.handoff.recipient !== props.context.identity.actor
  )
    return null;
  return (
    <>
      <HumanPromptControl {...props} control="mute" />
      <HumanPromptControl {...props} control="snooze" />
    </>
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
  const prompts = readHumanPrompts(handoff.text);
  const answer = useCallback((id: string) => void form.send("reply", id), [form]);
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
      {handoff.recipient === context.identity.actor
        ? prompts?.items.map((item, index) => (
            <ChoiceButton
              key={item.id}
              value={item.id}
              disabled={locked || !state.text.trim()}
              onSelect={answer}
            >
              Answer prompt {index + 1}
            </ChoiceButton>
          ))
        : null}
      {state.status === "pending" ? <Text style={styles.hint}>Sending…</Text> : null}
      <HumanPromptControls handoff={handoff} context={context} onSuccess={onSuccess} />
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
  filterRail: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
    gap: theme.spacing[2],
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  identity: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  listContent: {
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[6],
    },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
    gap: theme.spacing[1],
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
  rowFrame: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.lg,
    marginBottom: {
      xs: theme.spacing[1],
      md: 0,
    },
  },
  rowPress: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowSelected: { backgroundColor: theme.colors.surface2 },
  rowHovered: { backgroundColor: theme.colors.surface1 },
  rowPressed: { backgroundColor: theme.colors.surface2 },
  rowContent: { flex: 1, minWidth: 0, overflow: "hidden", gap: 2 },
  rowTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    overflow: "hidden",
  },
  rowHandle: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  rowState: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  rowSnippet: { fontSize: theme.fontSize.base, color: theme.colors.foregroundMuted },
  rowMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  rowMetaText: {
    maxWidth: "100%",
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  rowMetaSeparator: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    opacity: 0.7,
  },
  rowColumns: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 0,
    gap: theme.spacing[3],
    marginLeft: theme.spacing[2],
  },
  columnMeta: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
    width: 132,
  },
  columnMetaReplies: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
    width: 96,
    textAlign: "right" as const,
  },
  columnMetaFixed: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
    width: 72,
    textAlign: "right" as const,
  },
  rowDiscuss: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    marginRight: theme.spacing[1],
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
  },
}));
