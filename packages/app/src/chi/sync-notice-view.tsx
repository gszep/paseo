import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const NOTICE_TITLE = "Sync needs to succeed";

/** Safe, non-diagnostic reasons for a failed or paused sync. */
export function syncNoticeReason(code: string | null): string {
  if (!code) return "Sync did not complete. Retry when this host is back online.";
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
  onDismiss,
  onRetry,
}: {
  error: string;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  return (
    <View style={styles.container} testID="chi-sync-notice">
      <Alert variant="error" title={NOTICE_TITLE} description={syncNoticeReason(error)}>
        <Button size="sm" variant="ghost" onPress={onDismiss}>
          Dismiss
        </Button>
        <Button size="sm" variant="outline" onPress={onRetry}>
          Retry
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
