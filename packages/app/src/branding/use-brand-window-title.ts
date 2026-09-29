import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "react-native-reanimated";
import { isNative } from "@/constants/platform";
import { BRAND } from "./brand";
import { formatWindowTitle } from "./window-title";

/**
 * Drives the browser/window title from the active session label.
 *
 * The default Paseo brand leaves the title unchanged. A branded build prefixes
 * the brand mark and, while an agent is working, animates through the working
 * indicator frames (settling on the title mark when idle). Motion is skipped
 * under prefers-reduced-motion.
 */
export function useBrandWindowTitle({
  label,
  titleState,
  isRunning,
}: {
  label: string;
  titleState: "ready" | "loading";
  isRunning: boolean;
}): void {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (isNative || typeof document === "undefined") return;

    const resolvedLabel =
      titleState === "loading"
        ? t("workspace.tabs.loading")
        : label.trim() || t("workspace.tabs.fallback.workspace");

    const titleMark = BRAND.titleMark;
    if (titleMark === null) {
      document.title = resolvedLabel;
      return;
    }

    const indicator = BRAND.workingIndicator;
    if (!isRunning || reduceMotion || !indicator) {
      document.title = formatWindowTitle({ titleMark, mark: titleMark, label: resolvedLabel });
      return;
    }

    let index = 0;
    const render = () => {
      const frame = indicator.frames[index % indicator.frames.length] ?? titleMark;
      index += 1;
      document.title = formatWindowTitle({ titleMark, mark: frame, label: resolvedLabel });
    };
    render();
    const timer = setInterval(render, indicator.intervalMs);
    return () => clearInterval(timer);
  }, [label, titleState, isRunning, reduceMotion, t]);
}
