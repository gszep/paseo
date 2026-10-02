// Browser component fixtures do not own an Expo navigation container.
export const router = { push: () => {} };
export const usePathname = () => "/chi";
export const useLocalSearchParams = () => ({});
