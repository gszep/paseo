// Browser component fixtures do not own an Expo navigation container.
export { useEffect as useFocusEffect } from "react";
export const router = { push: () => {} };
export const usePathname = () => "/chi";
export const useLocalSearchParams = () => ({});
export const useRouter = () => router;
export function Stack() {
  throw new Error("Browser component fixtures do not own an Expo stack");
}
export function useNavigationContainerRef() {
  throw new Error("Browser component fixtures do not own an Expo navigation container");
}
