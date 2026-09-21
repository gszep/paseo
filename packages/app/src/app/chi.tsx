import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ChiContinueScreen } from "@/chi/continue-screen";

export default function ChiContinueRoute() {
  const params = useLocalSearchParams<{ repo?: string; source?: string; snapshot?: string }>();
  const repo = typeof params.repo === "string" ? params.repo : "";
  const sourceId = typeof params.source === "string" ? params.source : "";
  const snapshotId = typeof params.snapshot === "string" ? params.snapshot : "";
  return (
    <HostRouteBootstrapBoundary>
      <ChiContinueScreen
        key={`${repo}/${sourceId}/${snapshotId}`}
        repo={repo}
        sourceId={sourceId}
        snapshotId={snapshotId}
      />
    </HostRouteBootstrapBoundary>
  );
}
