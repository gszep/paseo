import { useEffect, useState } from "react";
import { Text } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { SyncedLoader } from "@/components/synced-loader";
import { BRAND } from "./brand";
import { getRestingIndicatorFrame } from "./working-indicator";

/**
 * The agent working indicator. Branded builds cycle a configured frame sequence;
 * the default Paseo brand keeps the built-in synced loader. Motion is reduced to
 * the resting frame under prefers-reduced-motion.
 */
export function BrandWorkingIndicator({ size = 10, color }: { size?: number; color: string }) {
  const reduceMotion = useReducedMotion();
  const indicator = BRAND.workingIndicator;
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (!indicator || reduceMotion) return;
    setFrameIndex(0);
    const timer = setInterval(
      () => setFrameIndex((index) => (index + 1) % indicator.frames.length),
      indicator.intervalMs,
    );
    return () => clearInterval(timer);
  }, [indicator, reduceMotion]);

  if (!indicator) {
    return <SyncedLoader size={size} color={color} />;
  }

  const frame = reduceMotion
    ? getRestingIndicatorFrame(indicator, BRAND.titleMark)
    : (indicator.frames[frameIndex] ?? indicator.frames[0]);

  return (
    <Text
      allowFontScaling={false}
      selectable={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.frame, { color, fontSize: size, lineHeight: size + 4 }]}
    >
      {frame}
    </Text>
  );
}

const styles = StyleSheet.create({
  frame: {
    fontWeight: "500",
    textAlign: "center",
  },
});
