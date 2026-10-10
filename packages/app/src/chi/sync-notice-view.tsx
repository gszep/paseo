import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { mentionError } from "./mention-errors";

const NOTICE_TITLE =
  "For others to see this session and for its mentions to appear, sync needs to succeed.";

export const WORKSPACE_NOTICE_TITLE = "Sync needs attention for another session in this workspace.";

export const OMITTED_CONTENT_WARNING =
  "A secret was found in content that was left out of the upload. Rotate it or clean the session history.";

/** Non-blocking warning copy; the capture synced, but omitted content held a secret. */
export function syncWarningReason(code: string): string {
  if (code === "capture-local-secret-omitted-content") return OMITTED_CONTENT_WARNING;
  return "This session synced with content left out of the upload.";
}

/** Safe, non-diagnostic reasons for a failed or paused sync. */
export function syncNoticeReason(code: string | null): string {
  if (!code) return "Sync did not complete. Retry when this host is back online.";
  if (
    [
      "capture-head-diverged",
      "capture-recovery-invalid",
      "capture-local-scan-timeout",
      "capture-native-projection-invalid",
      "chi-operation-timeout",
      "capture-local-cut-scan-limit",
      "capture-local-secret-scan-limit",
      "capture-local-secret-rejected",
      "evidence-http-422-server-secret-scan-rejected",
      "capture-local-scanner-unavailable",
    ].includes(code)
  )
    return mentionError(new Error(code));
  if (["append-", "chi-native-"].some((prefix) => code.startsWith(prefix)))
    return mentionError(new Error(code));
  if (code === "chi-destination-required")
    return "Configure a Chi destination and repository mapping on this host before Share, Continue or mentions. Existing history stays paused until its original endpoint is configured.";
  if (code.startsWith("chi-destination-unmapped"))
    return "This repository is not mapped to a configured destination.";
  if (code.startsWith("chi-destination-mismatch") || code.startsWith("chi-destination-changed"))
    return "This session's destination no longer matches the configured mapping.";
  if (code.startsWith("evidence-http") || code.startsWith("chi-http"))
    return "The destination backend rejected or could not accept the last capture.";
  if (code.startsWith("chi-repository"))
    return "This host is not authorized for the repository's destination.";
  if (code.startsWith("chi-github-login")) return "Sign in to GitHub on this host, then retry.";
  if (code.startsWith("chi-session-busy"))
    return "Waiting for the current turn to settle. Retry after it finishes.";
  return "The last capture did not complete. Retry when this host is back online.";
}

/**
 * Presentational sync notice. Kept free of the runtime graph so the browser
 * test can render it without pulling navigation into dependency optimization.
 */
export function SyncNoticeView({
  error,
  terminal = false,
  onDismiss,
  onRetry,
}: {
  error: string;
  terminal?: boolean;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  return (
    <View style={styles.container} testID="chi-sync-notice">
      <Alert variant="error" title={NOTICE_TITLE} description={syncNoticeReason(error)}>
        <Button size="sm" variant="ghost" onPress={onDismiss}>
          Dismiss
        </Button>
        {terminal ? null : (
          <Button size="sm" variant="outline" onPress={onRetry}>
            Retry
          </Button>
        )}
      </Alert>
    </View>
  );
}

/**
 * Workspace-scoped sync notice: the failing session is not the one on screen.
 * Names the affected conversation(s) instead of implying "this session".
 */
export function WorkspaceSyncNoticeView({
  error,
  affected,
  terminal = false,
  onDismiss,
  onRetry,
}: {
  error: string;
  affected: ReadonlyArray<{ id: string; title: string | null }>;
  terminal?: boolean;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  return (
    <View style={styles.container} testID="chi-sync-notice-workspace">
      <Alert
        variant="error"
        title={WORKSPACE_NOTICE_TITLE}
        description={`${describeAffectedConversations(affected)} ${syncNoticeReason(error)}`}
      >
        <Button size="sm" variant="ghost" onPress={onDismiss}>
          Dismiss
        </Button>
        {terminal ? null : (
          <Button size="sm" variant="outline" onPress={onRetry}>
            Retry
          </Button>
        )}
      </Alert>
    </View>
  );
}

function describeAffectedConversations(
  affected: ReadonlyArray<{ id: string; title: string | null }>,
): string {
  if (affected.length === 0) return "A session in this workspace did not sync.";
  const titles = affected.map((agent) => agent.title?.trim()).filter(Boolean) as string[];
  if (titles.length === affected.length) {
    const shown = titles.slice(0, 2);
    const rest = affected.length - shown.length;
    return `Affected session${affected.length === 1 ? "" : "s"}: ${shown.join(", ")}${
      rest > 0 ? ` and ${rest} more` : ""
    }.`;
  }
  return `Affected session${affected.length === 1 ? "" : "s"}: ${affected.length}.`;
}

/** Workspace-scoped omitted-content warning for a session that is not on screen. */
export function WorkspaceSyncWarningView({
  warning,
  affected,
  onDismiss,
}: {
  warning: string;
  affected: ReadonlyArray<{ id: string; title: string | null }>;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.container} testID="chi-sync-warning-workspace">
      <Alert
        variant="warning"
        title="A session in this workspace synced with a hidden secret"
        description={`${describeAffectedConversations(affected)} ${syncWarningReason(warning)}`}
      >
        <Button size="sm" variant="ghost" onPress={onDismiss}>
          Dismiss
        </Button>
      </Alert>
    </View>
  );
}

/**
 * Non-blocking warning notice: the capture synced, but omitted content held a
 * secret. Dismiss only; there is nothing to retry.
 */
export function SyncWarningView({
  warning,
  onDismiss,
}: {
  warning: string;
  onDismiss: () => void;
}) {
  return (
    <View style={styles.container} testID="chi-sync-warning">
      <Alert
        variant="warning"
        title="Synced with a hidden secret"
        description={syncWarningReason(warning)}
      >
        <Button size="sm" variant="ghost" onPress={onDismiss}>
          Dismiss
        </Button>
      </Alert>
    </View>
  );
}

/**
 * Dismissal state for the sync notice: hiding is keyed to the actual subject
 * (session/checkpoint) and error, so dismissing one conversation never silences
 * another's, and a success (null error) clears the dismissal.
 */
export function useSyncNoticeDismissal(error: string | null, subject = "") {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = error ? `${subject}|${error}` : null;
  useEffect(() => {
    if (!error) setDismissed(null);
  }, [error]);
  const dismiss = useCallback(() => setDismissed(key), [key]);
  return { visible: Boolean(error) && key !== dismissed, dismiss };
}

const styles = StyleSheet.create((theme) => ({
  container: { paddingHorizontal: theme.spacing[3], paddingTop: theme.spacing[2] },
}));
