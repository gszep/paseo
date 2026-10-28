import type { BrandWorkingIndicator } from "./brand";

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
