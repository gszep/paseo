import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function InboxCoverageNotice({ unavailableRepos }: { unavailableRepos?: string[] }) {
  if (!unavailableRepos?.length) return null;
  return (
    <Text accessibilityRole="alert" testID="inbox-incomplete" style={styles.notice}>
      Some repositories unavailable — inbox incomplete. Unread count is incomplete.
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: { color: theme.colors.foregroundMuted, padding: theme.spacing[4] },
}));
