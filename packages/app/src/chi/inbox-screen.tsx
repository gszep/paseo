import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import type { ChiHandoff } from "@getpaseo/protocol/chi-mentions";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Alert } from "@/components/ui/alert";
import { MenuHeader } from "@/components/headers/menu-header";
import { SearchField } from "@/components/ui/search-field";
import { HighlightedText } from "@/components/ui/highlighted-text";
import { findHighlightRanges } from "@/components/ui/highlighted-text-segments";
import { formatTimeAgo } from "@/utils/time";
import { useIsCompactFormFactor } from "@/constants/layout";
import { mentionError } from "./mention-errors";
import { useInbox, useInboxTransport, useInboxReader, type InboxContext } from "./use-inbox";
import { useViewedHandoff } from "./use-viewed-handoff";
import { RepositoryFilter } from "./repository-filter";
import { inboxDetailQueryOptions } from "./inbox-query";
import { InboxCoverageNotice } from "./inbox-coverage";
import {
  ALL_REPOSITORIES_OPTION_ID,
  buildInboxRows,
  filterInboxHandoffs,
  repositoryLabel,
  inboxWorkspaceName,
  inboxRepositories,
  type InboxListRow,
} from "./inbox-model";

function rowKey(row: InboxListRow) {
  return row.key;
}
type InboxDirection = "received" | "sent";
const directionOptions: SegmentedControlOption<InboxDirection>[] = [
  { value: "received", label: "Received", testID: "inbox-received" },
  { value: "sent", label: "Sent", testID: "inbox-sent" },
];
function EmptyInbox({ filtered }: { filtered: boolean }) {
  return <Text style={styles.hint}>{filtered ? "No mentions match" : "No mentions yet"}</Text>;
}
function LoadingMore() {
  return <Text style={styles.hint}>Loading more mentions…</Text>;
}
function InboxReadStatus({
  query,
  refresh,
}: {
  query: ReturnType<typeof useInbox>;
  refresh(): void;
}) {
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
  const transport = useInboxReader({ deploymentInbox: true });
  const { scope, state, host } = transport;
  const retry = useCallback(() => void scope.acquire().catch(() => undefined), [scope]);
  const { context } = transport;
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
      {host && context && !state.loading && !context.identity.deploymentInbox ? (
        <Alert
          variant="info"
          title="Mentions unavailable"
          description={mentionError(new Error("chi-deployment-inbox-backend-upgrade-required"))}
        />
      ) : null}
      {host && context?.identity.deploymentInbox && !state.loading ? (
        <DirectedInbox
          key={`${host}/${state.generation}`}
          transport={transport}
          context={context}
        />
      ) : null}
    </View>
  );
}

function DirectedInbox({
  transport,
  context,
}: {
  transport: ReturnType<typeof useInboxTransport>;
  context: InboxContext;
}) {
  const params = useLocalSearchParams<{ direction?: string }>();
  const direction = params.direction === "sent" ? "sent" : "received";
  const selectDirection = useCallback((value: InboxDirection) => {
    router.setParams({ direction: value });
  }, []);
  return (
    <Inbox
      key={direction}
      transport={transport}
      context={context}
      direction={direction}
      selectDirection={selectDirection}
    />
  );
}

function Inbox({
  transport,
  context,
  direction,
  selectDirection,
}: {
  transport: ReturnType<typeof useInboxTransport>;
  context: InboxContext;
  direction: InboxDirection;
  selectDirection(value: InboxDirection): void;
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
  const [scrolledDown, setScrolledDown] = useState(false);
  useEffect(() => {
    if (compact && selected) setScrolledDown(false);
  }, [compact, selected]);
  const scroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) =>
      setScrolledDown(event.nativeEvent.contentOffset.y > 0),
    [],
  );
  // The recipient inbox shares its first page with the sidebar badge.
  const query = useInbox(transport, {
    inbox: direction === "received",
    paused: scrolledDown,
    autoContinue: true,
  });
  const loaded = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.handoffs),
    [query.data],
  );
  const filtered = useMemo(
    () => filterInboxHandoffs(loaded, { search: searchInput, repository }),
    [loaded, searchInput, repository],
  );
  const repositories = useMemo(() => inboxRepositories(loaded), [loaded]);
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
    router.push({
      pathname: "/chi",
      params: { view: "conversation", repo: handoff.repo, handoff: handoff.id, sourceIndex: "0" },
    });
  }, []);
  const discuss = useCallback((handoff: ChiHandoff) => {
    setSelected(handoff);
  }, []);
  const renderRow = useCallback(
    ({ item }: { item: InboxListRow }) => (
      <InboxRow
        handoff={item.handoff}
        inbox={direction === "received"}
        search={searchInput}
        unread={
          direction === "received" &&
          !item.handoff.readAt &&
          item.handoff.recipient === context.identity.actor
        }
        selected={selected?.id === item.handoff.id && selected?.repo === item.handoff.repo}
        onSelect={choose}
        onDiscuss={discuss}
      />
    ),
    [searchInput, selected?.id, selected?.repo, choose, discuss, context.identity.actor, direction],
  );
  const isFiltered = searchInput.trim().length > 0 || repository !== ALL_REPOSITORIES_OPTION_ID;
  const repositoryOptionTestID = useCallback((id: string) => `inbox-repo-filter-item-${id}`, []);
  const emptyComponent = useMemo(() => <EmptyInbox filtered={isFiltered} />, [isFiltered]);
  return (
    <View style={styles.screen}>
      <View style={styles.filterRail}>
        <SegmentedControl
          options={directionOptions}
          value={direction}
          onValueChange={selectDirection}
          size="sm"
          testID="inbox-direction"
        />
        <View style={styles.filterRow}>
          <SearchField
            value={searchInput}
            onChangeText={setSearchInput}
            placeholder="Search mentions"
            clearAccessibilityLabel="Clear mention search"
            testID="inbox-search-input"
            clearTestID="inbox-search-clear"
          />
          {repositories.length > 1 || repository !== ALL_REPOSITORIES_OPTION_ID ? (
            <RepositoryFilter
              repositories={repositories}
              selected={repository}
              onSelect={setRepository}
              triggerTestID="inbox-repo-filter-trigger"
              optionTestID={repositoryOptionTestID}
            />
          ) : null}
        </View>
        <Text style={styles.identity} testID="inbox-identity">
          Signed in as @{context.identity.actor.slice(7)}
        </Text>
        {isFiltered ? <Text style={styles.hint}>Filtering loaded mentions</Text> : null}
      </View>
      <InboxReadStatus query={query} refresh={refresh} />
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
                key={`${selected.repo}/${selected.id}`}
                context={context}
                selected={selected}
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

/** Context stays secondary to the sender and message; opening never requires a local workspace. */
function InboxRow({
  handoff,
  inbox,
  search,
  unread,
  selected,
  onSelect,
  onDiscuss,
}: {
  handoff: ChiHandoff;
  inbox: boolean;
  search: string;
  unread: boolean;
  selected: boolean;
  onSelect(h: ChiHandoff): void;
  onDiscuss(h: ChiHandoff): void;
}) {
  const handle = `@${(inbox ? handoff.author : handoff.recipient).slice(7)}`;
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
            <Text style={styles.rowTime}>{timeAgo}</Text>
          </View>
          <View style={styles.rowMetaRow}>
            <HighlightedText
              text={workspace}
              ranges={ranges.workspace}
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

function HandoffDetail({ context, selected }: { context: InboxContext; selected: ChiHandoff }) {
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
  return <Discussion context={context} handoff={query.data} />;
}

function Discussion({ context, handoff: h }: { context: InboxContext; handoff: ChiHandoff }) {
  const [index, setIndex] = useState(0);
  const viewed = useViewedHandoff(context, h);
  const retryRead = viewed.retry;
  const chooseIndex = useCallback((value: string) => setIndex(Number(value)), []);
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
        <OpenSharedConversationButton key={index} handoff={h} index={index} />
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

function OpenSharedConversationButton({ handoff, index }: { handoff: ChiHandoff; index: number }) {
  const open = useCallback(
    () =>
      router.push({
        pathname: "/chi",
        params: {
          view: "conversation",
          repo: handoff.repo,
          handoff: handoff.id,
          sourceIndex: String(index),
        },
      }),
    [handoff.repo, handoff.id, index],
  );
  return <Button onPress={open}>Open shared conversation</Button>;
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
