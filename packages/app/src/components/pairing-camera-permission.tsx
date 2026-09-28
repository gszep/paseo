import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

interface CameraPermissionProps {
  onRequest: () => void;
  message?: string;
}

export function PairingCameraPermission({ onRequest, message }: CameraPermissionProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t("pairing.scan.cameraPermissionTitle")}</Text>
      <Text style={styles.body}>{message ?? t("pairing.scan.cameraPermissionBody")}</Text>
      <Pressable style={styles.button} onPress={onRequest} accessibilityRole="button">
        <Text style={styles.buttonText}>{t("pairing.scan.grantPermission")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginTop: theme.spacing[6],
    padding: theme.spacing[6],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[4],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  body: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  button: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.blue[500],
  },
  buttonText: { color: theme.colors.palette.white, fontWeight: theme.fontWeight.semibold },
}));
