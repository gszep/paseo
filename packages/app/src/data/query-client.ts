import { focusManager, QueryClient } from "@tanstack/react-query";
import { getVisibilitySnapshot, subscribeToVisibility } from "@/hooks/use-app-visible";

// Share the app's AppState/document boundary, including native foreground transitions.
focusManager.setEventListener((setFocused) => {
  setFocused(getVisibilitySnapshot());
  return subscribeToVisibility(() => setFocused(getVisibilitySnapshot()));
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
    },
  },
});
