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
export interface SyncDestinationResponse {
  destination: SyncDestination | null;
  pending: boolean;
  error: string | null;
  /** False when the destination is a peer deployment that cannot deliver mentions. */
  mentionsAvailable?: boolean;
}

export interface SyncDestinationState extends SyncDestinationResponse {
  mentionsAvailable: boolean;
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
    mentionsAvailable: input.response?.mentionsAvailable ?? false,
    loading: input.loading,
    retry: input.retry,
  };
}

/** Human-readable audience label for the chip details. */
export function syncAudienceLabel(audience: ChiAudience): string {
  return audience === "shared" ? "Shared with repository readers" : "Private";
}

/**
 * Secret-scan rejections are terminal: nothing was uploaded and retrying cannot
 * succeed until the local history changes. The notice hides its Retry action.
 */
export function isTerminalSecretError(code: string | null | undefined): boolean {
  return (
    code === "capture-local-secret-rejected" ||
    code === "capture-local-scanner-unavailable" ||
    code === "evidence-http-422-server-secret-scan-rejected"
  );
}
