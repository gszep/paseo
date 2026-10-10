import React, { useCallback, useMemo, type ComponentProps, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import {
  SpeakMessage,
  Notification,
  TodoListCard,
  CompactionMarker,
  ToolCall,
} from "@/components/message";
import { useRevealedText } from "@/hooks/use-revealed-text";
import { useStableEvent } from "@/hooks/use-stable-event";
import { OverviewToolCallGroupView } from "@/tool-calls/detail-level/overview/view";
import type { StreamItem } from "@/types/stream";
import type { createStreamPresentation } from "./presentation";
import type { StreamLayoutItem } from "./layout";

type RowRenderer = (layout: StreamLayoutItem) => ReactNode;
type Groups = ReturnType<ReturnType<typeof createStreamPresentation>>["groupsByHostId"];

/** The row body is shared; agent integrations are supplied only by the agent view. */
export function useStreamRowRenderer({
  renderUserMessage,
  renderAssistantMessage,
  renderPlugin,
  groups,
  expandedGroupIds,
  onGroupExpandedChange,
  onInlineExpandedChange,
  autoExpandReasoning,
  cwd,
  onOpenFilePath,
  readOnly = false,
}: {
  renderUserMessage: RowRenderer;
  renderAssistantMessage: RowRenderer;
  renderPlugin?: RowRenderer;
  groups: Groups;
  expandedGroupIds: Set<string>;
  onGroupExpandedChange: (id: string, expanded: boolean) => void;
  onInlineExpandedChange: (id: string, expanded: boolean) => void;
  autoExpandReasoning: boolean;
  cwd?: string;
  onOpenFilePath?: (path: string) => void;
  readOnly?: boolean;
}) {
  const getGroup = useStableEvent((id: string) => groups.get(id));
  const renderSingleToolCall = useCallback(
    (
      item: Extract<StreamItem, { kind: "tool_call" }>,
      isLastInSequence: boolean,
      maxDetailHeight?: number,
    ) => {
      const { payload } = item;
      if (payload.source === "agent") {
        const data = payload.data;
        if (
          data.name === "speak" &&
          data.detail.type === "unknown" &&
          typeof data.detail.input === "string" &&
          data.detail.input.trim()
        ) {
          return <SpeakMessage message={data.detail.input} timestamp={item.timestamp.getTime()} />;
        }
        return (
          <ToolCallSlot
            readOnly={readOnly}
            itemId={item.id}
            onInlineDetailsExpandedChangeByItemId={onInlineExpandedChange}
            toolName={data.name}
            error={data.error}
            status={data.status}
            detail={data.detail}
            cwd={cwd}
            metadata={data.metadata}
            isLastInSequence={isLastInSequence}
            onOpenFilePath={onOpenFilePath}
            maxDetailHeight={maxDetailHeight}
          />
        );
      }
      const data = payload.data;
      return (
        <ToolCallSlot
          readOnly={readOnly}
          itemId={item.id}
          onInlineDetailsExpandedChangeByItemId={onInlineExpandedChange}
          toolName={data.toolName}
          args={data.arguments}
          result={data.result}
          status={data.status}
          isLastInSequence={isLastInSequence}
          onOpenFilePath={onOpenFilePath}
          maxDetailHeight={maxDetailHeight}
        />
      );
    },
    [cwd, onInlineExpandedChange, onOpenFilePath, readOnly],
  );

  return useCallback(
    (layout: StreamLayoutItem): ReactNode => {
      const item = layout.item;
      switch (item.kind) {
        case "user_message":
          return renderUserMessage(layout);
        case "assistant_message":
          return renderAssistantMessage(layout);
        case "thought":
          return (
            <ThoughtSlot
              itemId={item.id}
              onInlineDetailsExpandedChangeByItemId={onInlineExpandedChange}
              text={item.text}
              status={item.status}
              isLastInSequence={layout.isLastInToolSequence}
              defaultExpanded={autoExpandReasoning}
            />
          );
        case "tool_call": {
          const group = getGroup(item.id);
          if (!group) return renderSingleToolCall(item, layout.isLastInToolSequence);
          const expanded = expandedGroupIds.has(group.run.id);
          return (
            <OverviewToolCallGroupView
              group={group}
              expanded={expanded}
              isLastInSequence={layout.isLastInToolSequence}
              onExpandedChange={onGroupExpandedChange}
            >
              {expanded
                ? group.run.calls.map((call, index) => (
                    <React.Fragment key={call.id}>
                      {renderSingleToolCall(call, index === group.run.calls.length - 1, 200)}
                    </React.Fragment>
                  ))
                : null}
            </OverviewToolCallGroupView>
          );
        }
        case "notification":
          return <Notification level={item.level} message={item.message} />;
        case "todo_list":
          return <TodoListCard items={item.items} activity={item.activity} />;
        case "compaction":
          return (
            <CompactionMarker
              status={item.status}
              trigger={item.trigger}
              preTokens={item.preTokens}
            />
          );
        case "plugin":
          return renderPlugin?.(layout) ?? null;
        default:
          return null;
      }
    },
    [
      renderUserMessage,
      renderAssistantMessage,
      renderPlugin,
      onInlineExpandedChange,
      autoExpandReasoning,
      getGroup,
      renderSingleToolCall,
      expandedGroupIds,
      onGroupExpandedChange,
    ],
  );
}

interface ToolCallSlotProps extends Omit<
  ComponentProps<typeof ToolCall>,
  "onInlineDetailsExpandedChange"
> {
  itemId: string;
  onInlineDetailsExpandedChangeByItemId: (id: string, expanded: boolean) => void;
}

function ToolCallSlot({
  itemId,
  onInlineDetailsExpandedChangeByItemId,
  ...rest
}: ToolCallSlotProps) {
  const handleExpandedChange = useCallback(
    (expanded: boolean) => onInlineDetailsExpandedChangeByItemId(itemId, expanded),
    [onInlineDetailsExpandedChangeByItemId, itemId],
  );
  return <ToolCall {...rest} onInlineDetailsExpandedChange={handleExpandedChange} />;
}

function ThoughtSlot({
  itemId,
  onInlineDetailsExpandedChangeByItemId,
  text,
  status,
  isLastInSequence,
  defaultExpanded,
}: {
  itemId: string;
  onInlineDetailsExpandedChangeByItemId: (id: string, expanded: boolean) => void;
  text: string;
  status: Extract<StreamItem, { kind: "thought" }>["status"];
  isLastInSequence: boolean;
  defaultExpanded: boolean;
}) {
  const revealedText = useRevealedText(text, status === "ready" ? "complete" : "streaming");
  return (
    <ToolCallSlot
      itemId={itemId}
      onInlineDetailsExpandedChangeByItemId={onInlineDetailsExpandedChangeByItemId}
      toolName="thinking"
      args={revealedText}
      status={status === "ready" ? "completed" : "executing"}
      isLastInSequence={isLastInSequence}
      defaultExpanded={defaultExpanded}
      forceInline={defaultExpanded}
    />
  );
}

export function StreamItemWrapper({
  gapBelow,
  children,
  highlighted = false,
}: {
  itemId: string;
  gapBelow: number;
  children: ReactNode;
  highlighted?: boolean;
}) {
  const style = useMemo(
    () => [styles.row, { marginBottom: gapBelow }, highlighted && styles.highlight],
    [gapBelow, highlighted],
  );
  return (
    <View style={style} testID={highlighted ? "referenced-history-item" : undefined}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
  highlight: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderColor: theme.colors.borderAccent,
    borderWidth: 1,
  },
}));
