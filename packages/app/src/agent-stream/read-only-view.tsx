import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AssistantMessage, MessageOuterSpacingProvider, UserMessage } from "@/components/message";
import { ToolCallSheetProvider } from "@/components/tool-call-sheet";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import type { StreamItem } from "@/types/stream";
import { buildAgentStreamRenderModel } from "./model";
import { layoutStream, type StreamLayoutItem } from "./layout";
import { StreamItemWrapper, useStreamRowRenderer } from "./rows";
import { resolveStreamRenderStrategy } from "./strategy-resolver";
import type { StreamSegmentRenderers, StreamViewportHandle } from "./strategy";
import { useStreamHistoryWindow } from "./use-stream-history-window";

export interface ReadOnlyStreamViewProps {
  /** View identity only. Never a native agent ID or a key into agent/runtime stores. */
  historyId: string;
  streamItems: StreamItem[];
  targetItemId?: string;
  historyPagination: {
    hasOlder: boolean;
    isLoadingOlder: boolean;
    progressKey: string | null;
    onLoadOlder: () => boolean | Promise<boolean>;
  };
  newerPagination?: {
    hasNewer: boolean;
    isLoadingNewer: boolean;
    onLoadNewer: () => boolean | Promise<boolean>;
  };
}

const EMPTY_ITEMS: StreamItem[] = [];
const EMPTY_GROUPS: Parameters<typeof useStreamRowRenderer>[0]["groups"] = new Map();
const EMPTY_EXPANDED_GROUPS = new Set<string>();
const ignoreNearBottom = () => {};
const ignoreGroupExpansion = () => {};

/** Supplied, pinned history: no host, agent, plugin, find, file, or live-tail integration. */
export function ReadOnlyStreamView(props: ReadOnlyStreamViewProps) {
  return <ReadOnlyHistory key={props.historyId} {...props} />;
}

function ReadOnlyHistory({
  historyId,
  streamItems,
  targetItemId,
  historyPagination,
  newerPagination,
}: ReadOnlyStreamViewProps) {
  const isMobile = useIsCompactFormFactor();
  const strategy = useMemo(
    () => resolveStreamRenderStrategy({ platform: Platform.OS, isMobileBreakpoint: isMobile }),
    [isMobile],
  );
  const viewportRef = useRef<StreamViewportHandle | null>(null);
  const scrolledTarget = useRef<string | undefined>(undefined);
  const [expandedInline, setExpandedInline] = useState<Set<string>>(() => new Set());
  const { start, hasLocalHistory, revealLoadedHistory, loadOlder } = useStreamHistoryWindow({
    // This hook and the viewport use the identity for local presentation state only.
    agentId: historyId,
    items: streamItems,
    loadRemoteOlder: historyPagination.onLoadOlder,
  });
  const model = useMemo(
    () =>
      buildAgentStreamRenderModel({
        isTurnActive: false,
        activeTurnStartedAt: null,
        tail: streamItems,
        head: EMPTY_ITEMS,
        platform: isWeb ? "web" : "native",
        isMobileBreakpoint: isMobile,
        historyStart: start,
      }),
    [streamItems, isMobile, start],
  );
  const layout = useMemo(
    () =>
      layoutStream({
        strategy,
        isTurnActive: false,
        history: model.history,
        liveHead: model.segments.liveHead,
        timingByAssistantId: model.turnTiming.byAssistantId,
      }),
    [strategy, model],
  );
  const rows = useMemo(() => new Map(layout.history.map((row) => [row.item.id, row])), [layout]);

  // Reveal the loaded local window first. The next commit mounts the row before the
  // normal viewport's measured jump runs; later page prepends must not re-jump it.
  useEffect(() => {
    if (!targetItemId) {
      scrolledTarget.current = undefined;
      return;
    }
    if (scrolledTarget.current === targetItemId) return;
    if (revealLoadedHistory(targetItemId)) return;
    if (!rows.has(targetItemId) || !viewportRef.current?.scrollToMessage) return;
    viewportRef.current.scrollToMessage(targetItemId);
    scrolledTarget.current = targetItemId;
  }, [targetItemId, rows, revealLoadedHistory]);

  const onInlineExpandedChange = useCallback((id: string, expanded: boolean) => {
    setExpandedInline((previous) => updateExpansion(previous, id, expanded));
  }, []);
  const renderContent = useStreamRowRenderer({
    readOnly: true,
    renderUserMessage: renderUserRow,
    renderAssistantMessage: renderAssistantRow,
    groups: EMPTY_GROUPS,
    expandedGroupIds: EMPTY_EXPANDED_GROUPS,
    onGroupExpandedChange: ignoreGroupExpansion,
    onInlineExpandedChange,
    autoExpandReasoning: false,
  });
  const renderRow = useCallback(
    (item: StreamItem) => {
      const row = rows.get(item.id);
      if (!row) return null;
      return (
        <StreamItemWrapper
          itemId={item.id}
          gapBelow={row.gapBelow}
          highlighted={item.id === targetItemId}
        >
          {renderContent(row)}
        </StreamItemWrapper>
      );
    },
    [rows, targetItemId, renderContent],
  );
  const loadNewer = useCallback(() => {
    void newerPagination?.onLoadNewer();
  }, [newerPagination]);
  const renderAuxiliary = useCallback(
    () =>
      newerPagination?.hasNewer ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Load newer history"
          disabled={newerPagination.isLoadingNewer}
          onPress={loadNewer}
          style={styles.pagination}
        >
          <Text style={styles.label}>
            {newerPagination.isLoadingNewer ? "Loading newer history…" : "Load newer history"}
          </Text>
        </Pressable>
      ) : null,
    [newerPagination, loadNewer],
  );
  const renderers = useMemo<StreamSegmentRenderers>(
    () => ({
      renderHistoryVirtualizedRow: renderRow,
      renderHistoryMountedRow: renderRow,
      renderLiveHeadRow: renderRow,
      renderLiveAuxiliary: renderAuxiliary,
    }),
    [renderRow, renderAuxiliary],
  );
  const historyRowRevision = useMemo(
    () => ({
      contentById: EMPTY_GROUPS,
      displayStateById: EMPTY_EXPANDED_GROUPS,
      globalDisplayState: isMobile,
    }),
    [isMobile],
  );
  const scrollEnabled =
    !strategy.shouldDisableParentScrollOnInlineDetailsExpansion() || expandedInline.size === 0;

  return (
    <View style={styles.container} testID="read-only-stream">
      <ToolCallSheetProvider>
        <MessageOuterSpacingProvider disableOuterSpacing>
          {strategy.render({
            agentId: historyId,
            segments: model.segments,
            boundary: model.boundary,
            historyRowRevision,
            renderers,
            listEmptyComponent: null,
            viewportRef,
            routeBottomAnchorRequest: null,
            isAuthoritativeHistoryReady: true,
            onNearBottomChange: ignoreNearBottom,
            onNearHistoryStart: loadOlder,
            isLoadingOlderHistory: historyPagination.isLoadingOlder,
            hasOlderHistory: hasLocalHistory || historyPagination.hasOlder,
            olderHistoryProgressKey: `${historyPagination.progressKey ?? "local"}:${start}`,
            scrollEnabled,
            listStyle: styles.container,
            baseListContentContainerStyle: styles.listContent,
            forwardListContentContainerStyle: styles.forwardContent,
          })}
        </MessageOuterSpacingProvider>
      </ToolCallSheetProvider>
    </View>
  );
}

function updateExpansion(previous: Set<string>, id: string, expanded: boolean) {
  const next = new Set(previous);
  if (expanded) next.add(id);
  else next.delete(id);
  return next;
}

function renderUserRow(layout: StreamLayoutItem) {
  const item = layout.item;
  if (item.kind !== "user_message") return null;
  return (
    <UserMessage
      readOnly
      message={item.text}
      timestamp={item.timestamp.getTime()}
      images={item.images}
      attachments={item.attachments}
      isFirstInGroup={layout.isFirstInUserGroup}
      isLastInGroup={layout.isLastInUserGroup}
    />
  );
}

function renderAssistantRow(layout: StreamLayoutItem) {
  const item = layout.item;
  if (item.kind !== "assistant_message") return null;
  return (
    <AssistantMessage
      readOnly
      occurrenceKey={item.id}
      message={item.text}
      timestamp={item.timestamp.getTime()}
      spacing={layout.assistantSpacing}
      phase="complete"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  listContent: {
    paddingVertical: 0,
    flexGrow: 1,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[4] },
  },
  forwardContent: { paddingTop: theme.spacing[4], paddingBottom: theme.spacing[4] },
  pagination: { alignItems: "center", padding: theme.spacing[3] },
  label: { color: theme.colors.foregroundMuted },
}));
