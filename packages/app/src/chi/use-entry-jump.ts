import { useEffect, useRef, type RefObject } from "react";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import { useEntryTarget } from "./entry-target";

export function useEntryJump(input: {
  host: string;
  agentId: string;
  active: boolean;
  items: StreamItem[];
  head?: StreamItem[];
  visible: ReadonlySet<string>;
  reveal(id: string): boolean;
  viewport: RefObject<StreamViewportHandle | null>;
}) {
  const { active, items, head, visible, reveal, viewport } = input;
  const target = useEntryTarget((state) =>
    state.target?.host === input.host && state.target.agentId === input.agentId
      ? state.target
      : null,
  );
  const completed = useRef<typeof target>(null);
  const requested = useRef<typeof target>(null);
  useEffect(() => {
    if (!target || !active || completed.current === target) return;
    const item = [...items, ...(head ?? [])].find(
      (row) =>
        row.kind === "user_message" &&
        row.timelineCursor?.epoch === target.epoch &&
        row.timelineCursor.seq === target.seq,
    );
    if (!item) {
      if (requested.current === target) return;
      requested.current = target;
      void getHostRuntimeStore()
        .fetchAgentTimeline(
          target.host,
          target.agentId,
          planTimelinePromptJump({ epoch: target.epoch, seq: target.seq }),
        )
        .catch(() => {
          useEntryTarget.setState({ target: null });
        });
      return;
    }
    if (!visible.has(item.id)) {
      reveal(item.id);
      return;
    }
    const frame = requestAnimationFrame(() => {
      viewport.current?.scrollToMessage?.(item.id);
      completed.current = target;
    });
    return () => cancelAnimationFrame(frame);
  }, [target, active, items, head, visible, reveal, viewport]);
  return target;
}
