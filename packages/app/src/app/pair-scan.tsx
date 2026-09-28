import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { PairingCamera } from "@/components/pairing-camera";
import { PairLinkModal, type PairLinkModalProps } from "@/components/pair-link-modal";
import { scannedPairingOffer } from "@/utils/scanned-pairing-offer";
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
  const focused = useIsFocused();
  const [stagedOffer, setStagedOffer] = useState<string | null>(null);
  const scanLocked = useRef(false);
  const pairedServer = useRef<string | null>(null);
  const handleSaved = useCallback<NonNullable<PairLinkModalProps["onSaved"]>>(({ serverId }) => {
    pairedServer.current = serverId;
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

  const closeConfirmation = useCallback(() => {
    if (pairedServer.current) navigateToPairedHost(pairedServer.current);
    else closeToSource();
  }, [navigateToPairedHost, closeToSource]);

  const handleScan = useCallback((text: string) => {
    if (scanLocked.current) return;
    const offer = scannedPairingOffer(text);
    if (!offer) return;
    scanLocked.current = true;
    setStagedOffer(offer);
  }, []);

  const bodyStyle = useMemo(
    () => [styles.body, { paddingBottom: insets.bottom + theme.spacing[6] }],
    [insets.bottom, theme.spacing],
  );

  return (
    <View style={styles.container}>
      <BackHeader title={t("pairing.scan.title")} onBack={closeToSource} />

      <View style={bodyStyle}>
        <View style={styles.cameraWrap}>
          {focused && !stagedOffer ? (
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
        </View>
      </View>
      {stagedOffer ? (
        <PairLinkModal
          visible
          initialOfferUrl={stagedOffer}
          onClose={closeConfirmation}
          onSaved={handleSaved}
        />
      ) : null}
    </View>
  );
}
