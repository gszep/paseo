import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useSyncDestination } from "./use-sync-destination";

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
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!state.error) setDismissed(null);
  }, [state.error]);
  const dismiss = useCallback(() => setDismissed(state.error), [state.error]);
  if (!state.error || state.error === dismissed) return null;
  return (
    <View style={styles.container} testID="chi-sync-notice">
      <Alert variant="error" title={NOTICE_TITLE} description={syncNoticeReason(state.error)}>
        <Button size="sm" variant="ghost" onPress={dismiss}>
          Dismiss
        </Button>
        <Button size="sm" variant="outline" onPress={state.retry}>
          Retry
        </Button>
      </Alert>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { paddingHorizontal: theme.spacing[3], paddingTop: theme.spacing[2] },
}));
