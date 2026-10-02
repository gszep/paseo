import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const NOTICE_TITLE =
  "For others to see this session and for its mentions to appear, sync needs to succeed.";

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
  if (code === "chi-destination-required")
    return "Configure a Chi destination and repository mapping on this host before Share, Continue or mentions. Existing history stays paused until its original endpoint is configured.";
  if (code === "capture-local-cut-scan-limit")
    return "This session exceeds the local truncation safety-scan limit. Nothing was uploaded. Start a shorter session or keep this session local.";
  if (
    code === "capture-local-secret-rejected" ||
    code === "evidence-http-422-server-secret-scan-rejected"
  )
    return "A secret was detected in this session's history. Nothing was uploaded. Remove or rotate the secret, or keep this session local.";
  if (code === "capture-local-scanner-unavailable")
    return "The secret scanner is unavailable on this host, so nothing was uploaded. Install gitleaks on the host to sync this session.";
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
 * Dismissal state for the sync notice: hiding is per-error, so a success (null
 * error) clears the dismissal and a later distinct failure shows again.
 */
export function useSyncNoticeDismissal(error: string | null) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!error) setDismissed(null);
  }, [error]);
  const dismiss = useCallback(() => setDismissed(error), [error]);
  return { visible: Boolean(error) && error !== dismissed, dismiss };
}

const styles = StyleSheet.create((theme) => ({
  container: { paddingHorizontal: theme.spacing[3], paddingTop: theme.spacing[2] },
}));
