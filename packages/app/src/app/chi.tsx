import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import type { ReactElement } from "react";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ChiContinueScreen } from "@/chi/continue-screen";
import { ChiInboxScreen } from "@/chi/inbox-screen";
import { ChiConversationScreen } from "@/chi/conversation-screen";

export default function ChiContinueRoute() {
  const params = useLocalSearchParams<{
    view?: string;
    handoff?: string;
    sourceIndex?: string;
    host?: string;
    workspace?: string;
    repo?: string;
    source?: string;
    snapshot?: string;
    sourceHost?: string;
    sourceSession?: string;
    agentId?: string;
    conversationId?: string;
    transferId?: string;
  }>();
  const repo = typeof params.repo === "string" ? params.repo : "";
  const sourceId = typeof params.source === "string" ? params.source : "";
  const snapshotId = typeof params.snapshot === "string" ? params.snapshot : "";
  const canonical = useMemo(
    () =>
      typeof params.conversationId === "string" && typeof params.transferId === "string"
        ? { conversationId: params.conversationId, transferId: params.transferId }
        : undefined,
    [params.conversationId, params.transferId],
  );
  let content: ReactElement;
  if (params.view === "conversation") {
    let sourceIndex = 0;
    if (params.sourceIndex !== undefined) {
      sourceIndex =
        typeof params.sourceIndex === "string" && /^(0|[1-9][0-9]*)$/.test(params.sourceIndex)
          ? Number(params.sourceIndex)
          : -1;
    }
    content = (
      <ChiConversationScreen
        repo={repo}
        handoffId={typeof params.handoff === "string" ? params.handoff : ""}
        sourceIndex={sourceIndex}
      />
    );
  } else if (params.view === "inbox") {
    content = <ChiInboxScreen />;
  } else {
    content = (
      <ChiContinueScreen
        key={`${repo}/${sourceId}/${snapshotId}/${params.sourceHost}/${params.agentId}/${params.conversationId}/${params.transferId}`}
        repo={repo}
        sourceId={sourceId}
        snapshotId={snapshotId}
        sourceHost={typeof params.sourceHost === "string" ? params.sourceHost : undefined}
        agentId={typeof params.agentId === "string" ? params.agentId : undefined}
        canonical={canonical}
      />
    );
  }
  return <HostRouteBootstrapBoundary>{content}</HostRouteBootstrapBoundary>;
}
