import { useCallback } from "react";
import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { CommunityLinks } from "@/components/community-links";
import { openExternalUrl } from "@/utils/open-external-url";
import { BRAND } from "./brand";

/**
 * The empty/home screen footer. The default Paseo brand keeps its community
 * links; a branded build can replace them with a single attribution link.
 */
export function BrandFooter() {
  const attribution = BRAND.attribution;

  const handlePress = useCallback(() => {
    if (attribution) void openExternalUrl(attribution.url);
  }, [attribution]);

  if (!attribution) {
    return <CommunityLinks />;
  }

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={attribution.label}
      onPress={handlePress}
      testID="brand-attribution-link"
    >
      <Text style={styles.text}>{attribution.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
