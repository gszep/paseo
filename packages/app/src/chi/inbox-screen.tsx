import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Text,
  View,
  ScrollView,
  Pressable,
  FlatList,
  type PressableStateCallbackType,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MessageSquare } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import type {
  ChiHandoff,
  ChiMentionOperation,
  ChiMentionResult,
  ChiMentionContext,
} from "@getpaseo/protocol/chi-mentions";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { MenuHeader } from "@/components/headers/menu-header";
import { SearchField } from "@/components/ui/search-field";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
import { formatTimeAgo } from "@/utils/time";
import { useIsCompactFormFactor } from "@/constants/layout";
import { mentionError } from "./mention-errors";
import { useInbox, useInboxTransport, useInboxCatalog } from "./use-inbox";
import { locateMention, openMentionTarget } from "./entry-navigation";
import { RepositoryFilter } from "./repository-filter";
import { inboxDetailQueryOptions } from "./inbox-query";
import { InboxCoverageNotice } from "./inbox-coverage";
import {
  ALL_REPOSITORIES_OPTION_ID,
  buildInboxRows,
  filterInboxHandoffs,
  repositoryLabel,
  inboxWorkspaceName,
  inboxRepositoryOptions,
  defaultInboxRepository,
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
function InboxReadStatus({
  query,
  repo,
  refresh,
}: {
  query: ReturnType<typeof useInbox>;
  repo: string | undefined;
  refresh(): void;
}) {
  if (!repo) return <Text style={styles.empty}>Choose a repository to read its mentions.</Text>;
  if (query.isError)
    return (
      <Alert
        variant="error"
        title="Unable to load mentions"
        description={mentionError(query.error)}
      >
        <Button onPress={refresh}>Retry</Button>
      </Alert>
    );
  if (query.isFetching && !query.data)
    return <Text style={styles.empty}>Refreshing mentions…</Text>;
  return <InboxCoverageNotice unavailableRepos={query.unavailableRepos} />;
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
        <Text style={styles.empty}>Verifying your Chi inbox account…</Text>
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
  const compact = useIsCompactFormFactor();
  const [searchInput, setSearchInput] = useState("");
  const [repository, selectRepository] = useState(ALL_REPOSITORIES_OPTION_ID);
  const [selected, setSelected] = useState<ChiHandoff | null>(null);
  const setRepository = useCallback((repo: string) => {
    selectRepository(repo);
    setSelected(null);
  }, []);
  const [openSession, setOpenSession] = useState(true);
  const [scrolledDown, setScrolledDown] = useState(false);
  useEffect(() => {
    if (compact && selected) setScrolledDown(false);
  }, [compact, selected]);
  const scroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) =>
      setScrolledDown(event.nativeEvent.contentOffset.y > 0),
    [],
  );
  const catalog = useInboxCatalog(transport);
  const repositories = inboxRepositoryOptions(context.identity, catalog.data);
  const defaultRepo = defaultInboxRepository(context.identity, repositories);
  const selectedRepo = repository === ALL_REPOSITORIES_OPTION_ID ? defaultRepo : repository;
  // The recipient inbox shares its first page with the sidebar badge.
  const query = useInbox(transport, {
    paused: scrolledDown,
    autoContinue: true,
    repo: selectedRepo,
  });
  const loaded = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.handoffs),
    [query.data],
  );
  const filtered = useMemo(
    () => filterInboxHandoffs(loaded, { search: searchInput, repository }),
    [loaded, searchInput, repository],
  );
  const rows = useMemo(() => buildInboxRows(filtered), [filtered]);
  const { fetchNextPage, hasNextPage, isFetching } = query;
  const refresh = useCallback(
    () => void cache.invalidateQueries({ queryKey: context.queryKey }),
    [cache, context.queryKey],
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
    ({ item }: { item: InboxListRow }) => (
      <InboxRow
        handoff={item.handoff}
        search={searchInput}
        unread={!item.handoff.readAt && item.handoff.recipient === context.identity.actor}
        selected={selected?.id === item.handoff.id}
        onSelect={choose}
        onDiscuss={discuss}
      />
    ),
    [searchInput, selected?.id, choose, discuss, context.identity.actor],
  );
  const isFiltered = searchInput.trim().length > 0 || repository !== ALL_REPOSITORIES_OPTION_ID;
  const repositoryOptionTestID = useCallback((id: string) => `inbox-repo-filter-item-${id}`, []);
  const emptyComponent = useMemo(() => <EmptyInbox filtered={isFiltered} />, [isFiltered]);
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
            selected={selectedRepo ?? ALL_REPOSITORIES_OPTION_ID}
            onSelect={setRepository}
            triggerTestID="inbox-repo-filter-trigger"
            optionTestID={repositoryOptionTestID}
          />
        </View>
        <Text style={styles.identity} testID="inbox-identity">
          Signed in as @{context.identity.actor.slice(7)}
        </Text>
        {catalog.isError ? (
          <Text accessibilityRole="alert" style={styles.hint}>
            Repository filter unavailable. {mentionError(catalog.error)}
          </Text>
        ) : null}
      </View>
      <InboxReadStatus query={query} repo={selectedRepo} refresh={refresh} />
      {query.data && !query.isError ? (
        <View style={compact ? styles.screen : styles.split}>
          {!compact || !selected ? (
            <FlatList
              testID="chi-flat-inbox"
              style={compact || !selected ? styles.screen : styles.list}
              contentContainerStyle={styles.listContent}
              data={rows}
              keyExtractor={rowKey}
              renderItem={renderRow}
              onEndReached={more}
              onScroll={scroll}
              scrollEventThrottle={100}
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
      {!query.isError && !query.isFetching && hasNextPage && rows.length === 0 ? (
        <Button onPress={more}>Load more mentions</Button>
      ) : null}
    </View>
  );
}

/** A workspace-led activity row, with the same readable preview on every screen size. */
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
  const handle = `@${handoff.author.slice(7)}`;
  const repo = repositoryLabel(handoff.repo);
  const workspace = inboxWorkspaceName(handoff);
  const timeAgo = formatTimeAgo(new Date(handoff.createdAt));
  const ranges = useMemo(
    () => ({
      handle: findHighlightRanges(search, handle),
      workspace: findHighlightRanges(search, workspace),
      text: findHighlightRanges(search, handoff.text),
    }),
    [search, handle, workspace, handoff.text],
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
              text={workspace}
              ranges={ranges.workspace}
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
            <Text style={styles.rowTime}>{timeAgo}</Text>
          </View>
          <View style={styles.rowMetaRow}>
            <HighlightedText
              text={handle}
              ranges={ranges.handle}
              style={styles.rowMetaText}
              numberOfLines={1}
            />
            <Text style={styles.rowMetaSeparator}>·</Text>
            <Text style={styles.rowMetaText} numberOfLines={1}>
              {repo}
            </Text>
          </View>
          <HighlightedText
            text={handoff.text}
            ranges={ranges.text}
            style={styles.rowSnippet}
            numberOfLines={2}
            testID={`mention-preview-${handoff.id}`}
          />
        </View>
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
  const query = useFetchQuery(
    inboxDetailQueryOptions({
      queryKey: context.queryKey,
      repo: selected.repo,
      id: selected.id,
      run: context.execute,
    }),
  );
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
  return <Discussion context={context} handoff={query.data} autoOpen={openSession} />;
}

function Discussion({
  context,
  handoff: h,
  autoOpen,
}: {
  context: InboxContext;
  handoff: ChiHandoff;
  autoOpen: boolean;
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
      void cache.invalidateQueries({ queryKey: [...context.queryKey, "inbox", true, h.repo] });
    },
  });
  const { mutate: markViewed, isIdle } = viewed;
  const retryRead = useCallback(() => markViewed(), [markViewed]);
  const chooseIndex = useCallback((value: string) => setIndex(Number(value)), []);
  useEffect(() => {
    if (!h.readAt && h.recipient === context.identity.actor && isIdle) markViewed();
  }, [h.readAt, h.recipient, context.identity.actor, isIdle, markViewed]);
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
              key={`${source.id}/${source.kind === "neutral" ? source.snapshot : ""}/${source.entryId}`}
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
  const [selectedSeq, setSelectedSeq] = useState<string | undefined>();
  const [browse, setBrowse] = useState(false);
  const [navigated, setNavigated] = useState(!autoOpen);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: [...context.queryKey, "source", handoff.repo, handoff.id, index, selectedSeq],
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
        seq: selectedSeq === undefined ? undefined : Number(selectedSeq),
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
      <Button size="sm" variant="ghost" onPress={next}>
        Browse pinned context
      </Button>
      {browse ? (
        <PinnedContext
          context={context}
          handoff={handoff}
          index={index}
          onSelect={setSelectedSeq}
        />
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
          value={String(entry.seq)}
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
    maxWidth: 720,
    width: "100%",
    alignSelf: "center",
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
    paddingVertical: theme.spacing[4],
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
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  rowTime: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, flexShrink: 0 },
  rowSnippet: {
    fontSize: theme.fontSize.content,
    color: theme.colors.foreground,
    lineHeight: theme.fontSize.content * 1.4,
    marginTop: theme.spacing[1],
  },
  rowMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  rowMetaText: {
    maxWidth: "100%",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowMetaSeparator: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    opacity: 0.7,
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
