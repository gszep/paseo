import { View, Text, Linking } from "react-native";
import { useCallback } from "react";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { Button } from "@/components/ui/button";
import { z } from "zod";

const associationSchema = z.object({
  repo: z.string(),
  sourceId: z.string().nullable(),
  head: z.string().nullable(),
  error: z.string().nullable(),
});
function readAssociation(value: string | undefined) {
  try {
    return value ? associationSchema.parse(JSON.parse(value)) : null;
  } catch {
    return null;
  }
}

export function ChiShare({ serverId, agentId }: { serverId: string; agentId: string }) {
  const client = useHostRuntimeClient(serverId);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.chiNative === true,
  );
  const provider = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.provider,
  );
  const label = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.labels["chi.native"],
  );
  const association = readAssociation(label);
  const action = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!client) throw new Error("Host disconnected");
      const result = await client.shareChi({ agentId, repo: association?.repo });
      if (result.outcome === "failed") throw new Error(result.error);
      return result;
    },
  });
  const open = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!association?.sourceId || !association.head) throw new Error("Capture has not completed");
      const fragment = new URLSearchParams({
        repo: association.repo,
        view: "native",
        source: association.sourceId,
        snapshot: association.head,
      });
      await Linking.openURL(`https://chi-backend-vadmp23swa-an.a.run.app/#${fragment}`);
    },
  });
  const { mutate: shareMutation } = action;
  const { mutate: openMutation } = open;
  const share = useCallback(() => shareMutation(), [shareMutation]);
  const openEvidence = useCallback(() => openMutation(), [openMutation]);
  if (!supported || provider !== "opencode") return null;
  return (
    <View style={styles.rail}>
      <Button size="sm" variant="ghost" disabled={action.isPending} onPress={share}>
        {association ? "Capture to Chi" : "Share to Chi"}
      </Button>
      {association ? (
        <Text style={styles.text}>Future settled turns are captured to Chi.</Text>
      ) : null}
      {association?.head ? (
        <Button size="sm" variant="ghost" onPress={openEvidence}>
          Open evidence
        </Button>
      ) : null}
      {association?.error ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {association.error}
        </Text>
      ) : null}
      {action.isError ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {action.error.message}
        </Text>
      ) : null}
      {open.isError ? (
        <Text accessibilityRole="alert" style={styles.text}>
          {open.error.message}
        </Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  rail: { paddingHorizontal: theme.spacing[3], gap: theme.spacing[1] },
  text: { color: theme.colors.foregroundMuted },
}));
