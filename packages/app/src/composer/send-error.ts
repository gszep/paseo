import { mentionError } from "@/chi/mention-errors";

/**
 * Friendly copy for a composer send failure. `host_restarting` only reaches
 * here after the client's automatic resend also failed, so it is safe to ask
 * the user to retry.
 */
export function friendlyComposerSendError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "host_restarting") {
    return "This host is restarting and could not accept the send automatically. Retry the same message once it reconnects.";
  }
  return message.startsWith("chi-") ? mentionError(message) : message;
}
