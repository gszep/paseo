export function mentionError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const copy: Record<string, string> = {
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
      "A secret was detected in this session's history. Nothing was uploaded. Remove or rotate the secret, or keep this session local.",
    "capture-local-cut-scan-limit":
      "This session exceeds the local truncation safety-scan limit. Nothing was uploaded. Start a shorter session or keep this session local.",
    "capture-local-scanner-unavailable":
      "The secret scanner is unavailable on this host, so nothing was uploaded. Install gitleaks on the host to sync this session.",
    "evidence-http-422-server-secret-scan-rejected":
      "A secret was detected in this session's history. Nothing was uploaded. Remove or rotate the secret, or keep this session local.",
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
