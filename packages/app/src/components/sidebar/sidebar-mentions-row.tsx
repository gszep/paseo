import { router } from "expo-router";
import { AtSign } from "lucide-react-native";
import { useCallback } from "react";
import { SidebarHeaderRow } from "./sidebar-header-row";
import { useInbox, useInboxTransport } from "@/chi/use-inbox";

export function SidebarMentionsRow({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const transport = useInboxTransport();
  const inbox = useInbox(transport);
  const unread =
    transport.host && transport.state.context && !inbox.isError
      ? inbox.data?.pages[0]?.unreadCount
      : undefined;
  const press = useCallback(() => {
    onBeforeNavigate?.();
    router.push({ pathname: "/chi", params: { view: "inbox" } });
  }, [onBeforeNavigate]);
  return (
    <SidebarHeaderRow
      icon={AtSign}
      label="Mentions"
      badge={unread}
      badgeIncomplete={
        unread !== undefined &&
        Boolean(inbox.data?.pages[0]?.unreadCountIsLowerBound || inbox.unavailableRepos.length)
      }
      onPress={press}
      testID="sidebar-mentions"
      variant="compact"
    />
  );
}
