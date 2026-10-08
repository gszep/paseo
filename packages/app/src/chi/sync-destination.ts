import type { ChiAudience } from "@getpaseo/protocol/messages";

export interface SyncDestination {
  id: string;
  name: string;
  endpoint: string;
  audience: ChiAudience;
  /** Authenticated Chi account pinned on the association, if any. */
  actor?: string | null;
  /** The mapping rule that matched, e.g. `github:owner/repo` or `github:owner/*`. */
  matchedRule?: string | null;
}

/** The daemon's answer for one workspace; null destination means local. */
interface SyncDestinationResponse {
  destination: SyncDestination | null;
  pending: boolean;
  error: string | null;
  /** Non-blocking capture warning, e.g. a secret only in omitted content. */
  warning?: string | null;
  /** False when the destination is a peer deployment that cannot deliver mentions. */
  mentionsAvailable?: boolean;
}

export interface SyncDestinationState extends SyncDestinationResponse {
  mentionsAvailable: boolean;
  warning: string | null;
  /** True until the first status response for a connected host. Never a local verdict. */
  loading: boolean;
  retry: () => void;
}

export function syncDestinationQueryKey(serverId: string, workspaceId: string) {
  return ["chi-sync-status", serverId, workspaceId] as const;
}

/** Pure mapping from query state to the hook's exposed state. */
export function deriveSyncDestinationState(input: {
  response: SyncDestinationResponse | null;
  loading: boolean;
  retry: () => void;
}): SyncDestinationState {
  return {
    destination: input.response?.destination ?? null,
    pending: input.response?.pending ?? false,
    error: input.response?.error ?? null,
    warning: input.response?.warning ?? null,
    mentionsAvailable: input.response?.mentionsAvailable ?? false,
    loading: input.loading,
    retry: input.retry,
  };
}

/** Human-readable audience label for the chip details. */
export function syncAudienceLabel(audience: ChiAudience): string {
  return audience === "shared" ? "Shared with repository readers" : "Private";
}

export const CAPTURE_HEAD_DIVERGED_MESSAGE =
  "The archived session differs from this host's history or is no longer available. Sync stopped to preserve local work and any archived history. Removed sources are never recreated automatically. Compare the archive and other hosts; continue from an available canonical session, or use OpenCode Fork to preserve this host's work as a new source.";
export const CAPTURE_RECOVERY_INVALID_MESSAGE =
  "Chi could not verify the archived history for safe recovery. Automatic sync stopped. Update this host if needed, then compare the archive and local session before explicitly retrying.";
export const CHI_OPERATION_TIMEOUT_MESSAGE =
  "Chi timed out before confirming the operation. A batch may already have committed. Retry the same request to confirm its saved result.";
export const CAPTURE_SCAN_TIMEOUT_MESSAGE =
  "The secret scan exceeded its deadline. This batch was not sent by the current attempt. Retry sync; earlier attempts or batches may already have committed.";

/** Rejections that require human recovery rather than an automatic retry. */
export function isTerminalSyncError(code: string | null | undefined): boolean {
  return (
    code === "capture-head-diverged" ||
    code === "capture-recovery-invalid" ||
    code === "capture-local-secret-rejected" ||
    code === "capture-local-cut-scan-limit" ||
    code === "capture-local-secret-scan-limit" ||
    code === "append-recovery-required" ||
    code === "append-local-conflict" ||
    code === "append-local-state-invalid" ||
    code === "capture-native-projection-invalid" ||
    code === "chi-native-reset-required" ||
    code === "chi-native-fork-unsupported" ||
    code === "chi-native-workspace-mismatch" ||
    code === "chi-native-platform-unsupported" ||
    code === "chi-native-runtime-unsupported" ||
    code === "append-http-404" ||
    code === "evidence-http-422-server-secret-scan-rejected"
  );
}
