import { useCallback } from "react";
import { Button } from "@/components/ui/button";
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
    <Button
      variant="ghost"
      size="sm"
      accessibilityRole="link"
      onPress={handlePress}
      testID="brand-attribution-link"
    >
      {attribution.label}
    </Button>
  );
}
