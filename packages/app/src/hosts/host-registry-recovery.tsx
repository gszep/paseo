import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { ReactNode } from "react";
import type { HostRegistryStatus } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerTheme = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function HostRegistryBoundary({
  status,
  onRetry,
  children,
}: {
  status: HostRegistryStatus;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (status === "error") return <HostRegistryRecovery onRetry={onRetry} />;
  if (status === "loading")
    return (
      <View style={styles.container}>
        <ThemedLoadingSpinner uniProps={spinnerTheme} />
      </View>
    );
  return children;
}

export function HostRegistryRecovery({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="host-registry-error">
      <Text style={styles.title}>{t("hostRegistry.loadFailed")}</Text>
      <Text style={styles.description}>{t("hostRegistry.retained")}</Text>
      <Button onPress={onRetry} testID="host-registry-retry">
        {t("common.actions.retry")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    maxWidth: 440,
  },
}));
