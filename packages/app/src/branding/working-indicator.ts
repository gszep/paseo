import type { BrandWorkingIndicator } from "./brand";

/**
 * The kanji sequence and timing used by the retired chi-theme extension, reused
 * verbatim so the hosted app's working indicator matches the historical Chi
 * runtime identity.
 */
export const CHI_WORKING_INDICATOR: BrandWorkingIndicator = {
  frames: ["干", "千", "午", "牛", "丰", "生", "丰", "牛", "午", "千"],
  intervalMs: 90,
};

/** The frame shown `nowMs` milliseconds into an activation. */
export function getWorkingIndicatorFrame(nowMs: number, indicator: BrandWorkingIndicator): string {
  const { frames, intervalMs } = indicator;
  const index = Math.floor(Math.max(0, nowMs) / intervalMs) % frames.length;
  return frames[index] ?? frames[0];
}

/**
 * The frame an indicator rests on when motion is reduced: the brand's title
 * mark when it has one, otherwise the sequence's settled last frame.
 */
export function getRestingIndicatorFrame(
  indicator: BrandWorkingIndicator,
  titleMark: string | null,
): string {
  return titleMark ?? indicator.frames[indicator.frames.length - 1] ?? "";
}
