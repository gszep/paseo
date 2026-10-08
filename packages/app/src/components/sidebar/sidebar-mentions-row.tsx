import { router } from "expo-router";
import { AtSign } from "lucide-react-native";
import { useCallback } from "react";
import { SidebarHeaderRow } from "./sidebar-header-row";

export function SidebarMentionsRow({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const press = useCallback(() => {
    onBeforeNavigate?.();
    router.push({ pathname: "/chi", params: { view: "inbox" } });
  }, [onBeforeNavigate]);
  return (
    <SidebarHeaderRow
      icon={AtSign}
      label="Mentions"
      onPress={press}
      testID="sidebar-mentions"
      variant="compact"
    />
  );
}
