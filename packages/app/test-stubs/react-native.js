export * from "react-native-web";

// RN Web does not export this Android-only API. Importing cross-platform rows
// must work in browser tests, but executing a native toast there is a failure.
export const ToastAndroid = {
  SHORT: 0,
  LONG: 1,
  TOP: 49,
  showWithGravity() {
    throw new Error("ToastAndroid is unavailable on web");
  },
};
