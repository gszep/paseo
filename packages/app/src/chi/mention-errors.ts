import {
  CAPTURE_HEAD_DIVERGED_MESSAGE,
  CAPTURE_RECOVERY_INVALID_MESSAGE,
  CAPTURE_SCAN_TIMEOUT_MESSAGE,
  CHI_OPERATION_TIMEOUT_MESSAGE,
} from "./sync-destination";

export function mentionError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const copy: Record<string, string> = {
    "capture-head-diverged": CAPTURE_HEAD_DIVERGED_MESSAGE,
    "capture-recovery-invalid": CAPTURE_RECOVERY_INVALID_MESSAGE,
    "capture-local-scan-timeout": CAPTURE_SCAN_TIMEOUT_MESSAGE,
    "append-recovery-required": CAPTURE_RECOVERY_INVALID_MESSAGE,
    "append-local-conflict": CAPTURE_RECOVERY_INVALID_MESSAGE,
    "append-local-state-invalid": CAPTURE_RECOVERY_INVALID_MESSAGE,
    "capture-native-projection-invalid":
      "Chi rejected this batch's projection. Sync stopped. Update this host or keep the session local.",
    "chi-native-v3-required":
      "V3 sync and mentions require a compatible host and backend. This release supports POSIX hosts.",
    "chi-native-platform-unsupported":
      "V3 sync requires private, durable POSIX receipts. It is not available on Windows in this release.",
    "chi-native-reset-required":
      "This session still has snapshot-format sync state. Keep it paused until the operator completes the v3 cutover.",
    "chi-native-fork-unsupported":
      "Sync for native forks is not available in this v3 release. Keep this fork local.",
    "chi-native-workspace-mismatch":
      "The native session belongs to a different checkout. Sync stopped to avoid sharing it with the wrong repository.",
    "chi-operation-unsupported":
      "This operation is not available in the v3 sync and mentions release.",
    "chi-mention-repository-required": "Choose a repository to read its mentions.",
    "append-http-404":
      "This source is no longer available to the host identity. Sync stopped; the source will not be recreated.",
    "chi-operation-timeout": CHI_OPERATION_TIMEOUT_MESSAGE,
    "chi-destination-required":
      "Configure a Chi destination and repository mapping on this host before Share, Continue or mentions. Inbox and mentions require one configured deployment; restart the daemon after changing it.",
    "chi-destination-changed":
      "This session's Chi destination was removed or changed. Restore its original destination to resume; history is never retargeted.",
    "chi-reply-storage-unavailable":
      "Unable to update saved reply storage. The original operation is retained. Try again after storage is available.",
    "chi-mention-text-too-long":
      "Human mentions and replies must be 8,000 characters or fewer. Shorten the text and send again.",
    "chi-github-login-required": "Sign in to GitHub on this host, then verify mention context.",
    "chi-reply-rejected":
      "The saved reply was rejected without committing. Correct it before sending a new operation.",
    "chi-share-required":
      "This workspace is local. Only workspaces mapped to a destination deliver human mentions.",
    "capture-local-secret-rejected":
      "A secret was detected in this batch. Sync stopped. Remove or rotate the secret, or keep this session local.",
    "capture-local-cut-scan-limit":
      "This batch exceeds the local truncation safety-scan limit. Sync stopped. Keep the session local until the oversized record is resolved.",
    "capture-local-secret-scan-limit":
      "This batch exceeds the local secret-scan limit. Sync stopped; keep the session local until the oversized record is resolved.",
    "capture-local-scanner-unavailable":
      "The secret scanner is unavailable on this host. Check the pinned Gitleaks installation, then retry sync.",
    "evidence-http-422-server-secret-scan-rejected":
      "A secret was detected in this batch. Sync stopped. Remove or rotate the secret, or keep this session local.",
    "chi-mentions-unsupported": "Update this host to use Chi mentions.",
    "chi-mention-plain-text-required":
      "Send human mentions as plain text. Remove attachments and slash/skill commands before sending.",
    "chi-mention-context-changed":
      "The host account, repository or credentials changed. Return to the original account and repository, verify mention context, then explicitly authorize the saved operation with current credentials.",
    "chi-mention-submission-unresolved":
      "A saved send is unconfirmed. Use Retry saved send to confirm that exact request before starting another send.",
    "chi-host-disconnected": "Reconnect this host, then verify mention context.",
    host_restarting:
      "This host is restarting and could not accept the send automatically. Retry the same operation once it reconnects.",
    "chi-session-busy": "Waiting for the current turn to settle. Retry after it finishes.",
    "chi-mention-persisted-entry-required":
      "The exact user message is not in a settled capture yet. Retry after the turn finishes.",
    "chi-mentions-http-401": "Sign in to GitHub on this host, then refresh.",
    "chi-mentions-http-403":
      "Your host identity cannot access this discussion. Check your GitHub account and project access.",
    "chi-mentions-http-404":
      "This discussion or its source is no longer available to your identity.",
    "chi-mentions-http-409": "The discussion changed. Refresh before starting a new reply.",
    "chi-mentions-http-422": "Chi rejected the content. Nothing new was delivered.",
    "chi-mentions-http-503": "Chi is temporarily unavailable. Retry the same delivery.",
    "chi-mentions-unavailable": "Unable to confirm delivery. Retry the same operation.",
  };
  return copy[code] ?? "Chi could not complete this operation. Reconnect this host and retry.";
}
