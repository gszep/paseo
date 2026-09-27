import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ChiContinueScreen } from "@/chi/continue-screen";
import { ChiInboxScreen } from "@/chi/inbox-screen";

export default function ChiContinueRoute() {
  const params = useLocalSearchParams<{
    view?: string;
    host?: string;
    workspace?: string;
    repo?: string;
    source?: string;
    snapshot?: string;
    sourceHost?: string;
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
  return (
    <HostRouteBootstrapBoundary>
      {params.view === "inbox" ? (
        <ChiInboxScreen
          key={`${params.host}/${params.workspace}`}
          host={typeof params.host === "string" ? params.host : undefined}
          workspace={typeof params.workspace === "string" ? params.workspace : undefined}
        />
      ) : (
        <ChiContinueScreen
          key={`${repo}/${sourceId}/${snapshotId}/${params.sourceHost}/${params.agentId}/${params.conversationId}/${params.transferId}`}
          repo={repo}
          sourceId={sourceId}
          snapshotId={snapshotId}
          sourceHost={typeof params.sourceHost === "string" ? params.sourceHost : undefined}
          agentId={typeof params.agentId === "string" ? params.agentId : undefined}
          canonical={canonical}
        />
      )}
    </HostRouteBootstrapBoundary>
  );
}
