import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { SyncDestination } from "./sync-destination";

export const MENTIONS_UNAVAILABLE_COPY = "Mentions are not available for this destination.";

/** Mentions can only be delivered through the primary deployment. */
export function mentionsUnavailable(
  destination: SyncDestination | null,
  mentionsAvailable: boolean,
): boolean {
  return Boolean(destination) && !mentionsAvailable;
}

/** Runtime-free hint so the browser suite can render it without the host graph. */
export function MentionsUnavailableHint({
  destination,
  mentionsAvailable,
}: {
  destination: SyncDestination | null;
  mentionsAvailable: boolean;
}) {
  if (!mentionsUnavailable(destination, mentionsAvailable)) return null;
  return <Text style={styles.text}>{MENTIONS_UNAVAILABLE_COPY}</Text>;
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
