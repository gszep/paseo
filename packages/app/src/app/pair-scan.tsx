import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PairingCamera } from "@/components/pairing-camera";
import { usePairingOffer } from "@/hooks/use-pairing-offer";
import { buildHostRootRoute, buildSettingsHostRoute } from "@/utils/host-routes";
import { BackHeader } from "@/components/headers/back-header";

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    paddingHorizontal: theme.spacing[6],
  },
  cameraWrap: {
    flex: 1,
    overflow: "hidden",
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  scanFrame: {
    width: 260,
    height: 260,
  },
  corner: {
    position: "absolute",
    width: 36,
    height: 36,
    borderColor: theme.colors.accent,
  },
  cornerTL: {
    left: 0,
    top: 0,
    borderLeftWidth: 4,
    borderTopWidth: 4,
    borderTopLeftRadius: 12,
  },
  cornerTR: {
    right: 0,
    top: 0,
    borderRightWidth: 4,
    borderTopWidth: 4,
    borderTopRightRadius: 12,
  },
  cornerBL: {
    left: 0,
    bottom: 0,
    borderLeftWidth: 4,
    borderBottomWidth: 4,
    borderBottomLeftRadius: 12,
  },
  cornerBR: {
    right: 0,
    bottom: 0,
    borderRightWidth: 4,
    borderBottomWidth: 4,
    borderBottomRightRadius: 12,
  },
  helperText: {
    marginTop: theme.spacing[6],
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    fontSize: theme.fontSize.base,
  },
  permissionCard: {
    marginTop: theme.spacing[6],
    padding: theme.spacing[6],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[4],
  },
  permissionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  permissionBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  permissionButton: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.blue[500],
  },
  permissionButtonText: {
    color: theme.colors.palette.white,
    fontWeight: theme.fontWeight.semibold,
  },
}));

export default function PairScanScreen() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{
    source?: string;
  }>();
  const source = typeof params.source === "string" ? params.source : "settings";
  const pairOffer = usePairingOffer();
  const focused = useIsFocused();
  const [isPairing, setIsPairing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const scanLocked = useRef(false);
  const scanAgain = useCallback(() => {
    scanLocked.current = false;
    setErrorMessage(undefined);
  }, []);

  const navigateToPairedHost = useCallback(
    (serverId: string) => {
      if (source === "onboarding") {
        router.replace(buildHostRootRoute(serverId));
        return;
      }
      router.replace(buildSettingsHostRoute(serverId));
    },
    [router, source],
  );

  const closeToSource = useCallback(() => {
    try {
      router.back();
    } catch {
      router.replace("/" as Href);
    }
  }, [router]);

  const handleScan = useCallback(
    async (text: string) => {
      if (scanLocked.current) return;
      scanLocked.current = true;
      try {
        setIsPairing(true);
        const { profile } = await pairOffer(text.trim());
        navigateToPairedHost(profile.serverId);
      } catch (error) {
        const message = error instanceof Error ? error.message : t("pairing.scan.unableToPair");
        setErrorMessage(message);
      } finally {
        setIsPairing(false);
      }
    },
    [navigateToPairedHost, t, pairOffer],
  );

  const bodyStyle = useMemo(
    () => [styles.body, { paddingBottom: insets.bottom + theme.spacing[6] }],
    [insets.bottom, theme.spacing],
  );
  const helperTextStyle = useMemo(
    () => [styles.helperText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );

  return (
    <View style={styles.container}>
      <BackHeader title={t("pairing.scan.title")} onBack={closeToSource} />

      <View style={bodyStyle}>
        {errorMessage ? (
          <View style={styles.permissionCard}>
            <Text style={styles.permissionTitle}>{t("pairing.scan.errorTitle")}</Text>
            <Text style={styles.permissionBody} accessibilityRole="alert">
              {errorMessage}
            </Text>
            <Pressable
              style={styles.permissionButton}
              accessibilityRole="button"
              onPress={scanAgain}
            >
              <Text style={styles.permissionButtonText}>{t("pairing.scan.scanAgain")}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.cameraWrap}>
            {focused && !isPairing && !scanLocked.current ? (
              <PairingCamera onScan={handleScan}>
                <View style={styles.overlay} pointerEvents="none">
                  <View style={styles.scanFrame}>
                    <View style={[styles.corner, styles.cornerTL]} />
                    <View style={[styles.corner, styles.cornerTR]} />
                    <View style={[styles.corner, styles.cornerBL]} />
                    <View style={[styles.corner, styles.cornerBR]} />
                  </View>
                </View>
              </PairingCamera>
            ) : null}
            {isPairing ? (
              <View style={styles.overlay}>
                <Text style={helperTextStyle}>{t("pairing.scan.pairing")}</Text>
              </View>
            ) : null}
          </View>
        )}
      </View>
    </View>
  );
}
