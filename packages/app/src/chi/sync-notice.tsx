import { isTerminalSyncError } from "./sync-destination";
import { SyncNoticeView, SyncWarningView, useSyncNoticeDismissal } from "./sync-notice-view";
import { useSyncDestination } from "./use-sync-destination";

export { syncNoticeReason, syncWarningReason, OMITTED_CONTENT_WARNING } from "./sync-notice-view";

/**
 * A single dismissible sync notice, mounted outside the chat feed. An error
 * hides behind its own dismissal; an omitted-content warning (the capture
 * synced) is non-blocking and shown only when there is no error.
 */
export function WorkspaceSyncNotice({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const state = useSyncDestination(serverId, workspaceId);
  const errorDismissal = useSyncNoticeDismissal(state.error);
  const warningDismissal = useSyncNoticeDismissal(state.warning);
  if (state.error && errorDismissal.visible) {
    return (
      <SyncNoticeView
        error={state.error}
        terminal={isTerminalSyncError(state.error)}
        onDismiss={errorDismissal.dismiss}
        onRetry={state.retry}
      />
    );
  }
  if (!state.error && state.warning && warningDismissal.visible) {
    return <SyncWarningView warning={state.warning} onDismiss={warningDismissal.dismiss} />;
  }
  return null;
}
