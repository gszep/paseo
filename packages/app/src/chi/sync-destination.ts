import type { ChiAudience } from "@getpaseo/protocol/messages";

export interface SyncDestination {
  id: string;
  name: string;
  endpoint: string;
  audience: ChiAudience;
}

/** The daemon's answer for one workspace; null destination means local. */
export interface SyncDestinationResponse {
  destination: SyncDestination | null;
  pending: boolean;
  error: string | null;
}

export interface SyncDestinationState extends SyncDestinationResponse {
  /** True until the first successful status response. Never an error or local verdict. */
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
    loading: input.loading,
    retry: input.retry,
  };
}
