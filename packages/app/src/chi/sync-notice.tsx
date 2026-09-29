import { SyncNoticeView, useSyncNoticeDismissal } from "./sync-notice-view";
import { useSyncDestination } from "./use-sync-destination";

export { syncNoticeReason } from "./sync-notice-view";

/**
 * A single dismissible sync notice, mounted outside the chat feed. Dismissal
 * hides the notice but keeps the pending sync state; a later success clears it.
 */
export function WorkspaceSyncNotice({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const state = useSyncDestination(serverId, workspaceId);
  const { visible, dismiss } = useSyncNoticeDismissal(state.error);
  if (!state.error || !visible) return null;
  return <SyncNoticeView error={state.error} onDismiss={dismiss} onRetry={state.retry} />;
}
