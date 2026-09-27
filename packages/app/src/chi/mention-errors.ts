export function mentionError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const copy: Record<string, string> = {
    "chi-share-required": "Share this session to Chi before sending a human mention.",
    "chi-mentions-unsupported": "Update this host to use Chi mentions.",
    "chi-mention-plain-text-required":
      "Send human mentions as plain text. Remove attachments and slash/skill commands before sending.",
    "chi-mention-context-changed":
      "The host account, repository or credentials changed. Verify mention context before continuing; saved operations retain their original identity.",
    "chi-mention-submission-unresolved":
      "A saved send is unconfirmed. Use Retry saved send to confirm that exact request before starting another send.",
    "chi-host-disconnected": "Reconnect this host, then verify mention context.",
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
