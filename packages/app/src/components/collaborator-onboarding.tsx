import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { BRAND } from "@/branding/brand";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";

const styles = StyleSheet.create((theme) => ({
  steps: { width: "100%", maxWidth: 420, gap: theme.spacing[6], marginBottom: theme.spacing[6] },
  step: { gap: theme.spacing[3] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  copy: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
}));

function openGuide() {
  if (BRAND.agentSetup) void openExternalUrl(BRAND.agentSetup.url);
}
function connect() {
  if (BRAND.connect) void openExternalUrl(BRAND.connect.url);
}

/** Hosted brand opt-in only; native/upstream onboarding keeps its pairing flow. */
export function CollaboratorOnboarding() {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copyGuide = useCallback(async () => {
    if (!BRAND.agentSetup) return;
    try {
      await copyToClipboard(BRAND.agentSetup.url);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  }, []);
  if (!BRAND.agentSetup) return null;
  return (
    <View style={styles.steps} testID="collaborator-onboarding">
      {BRAND.connect ? (
        <View style={styles.step}>
          <Text style={styles.title}>1. Connect with your collaborators</Text>
          <Text style={styles.copy}>
            Sign in with your own GitHub account and check project access. No host is needed for
            sign-in. If integration is missing, guided setup explains the repository administrator’s
            one-time step.
          </Text>
          <Button onPress={connect} testID="welcome-connect-github">
            {BRAND.connect.label}
          </Button>
        </View>
      ) : null}
      <View style={styles.step}>
        <Text style={styles.title}>2. Set up an agent — only if you need one</Text>
        <Text style={styles.copy}>
          Give your agent this guide for the released installer, supported fresh-host setup, and
          current limits. Existing installations and history must be preserved, with permission
          before replacement.
        </Text>
        <Text selectable style={styles.copy}>
          {BRAND.agentSetup.url}
        </Text>
        <Button variant="outline" onPress={openGuide} testID="welcome-agent-setup">
          {BRAND.agentSetup.label}
        </Button>
        <Button variant="outline" onPress={copyGuide}>
          {copied ? "Guide URL copied" : "Copy guide URL"}
        </Button>
        {copyFailed ? (
          <Text style={styles.copy}>Copy unavailable. Select the URL above.</Text>
        ) : null}
      </View>
      <View style={styles.step}>
        <Text style={styles.title}>3. Pair your own supported host</Text>
        <Text style={styles.copy}>
          Use the QR or pairing-link controls below for host-backed work. Pairing is separate from
          GitHub sign-in. Participant registration needs only step 1.
        </Text>
      </View>
    </View>
  );
}
