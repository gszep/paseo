import { describe, expect, test } from "vitest";
import type { BrandWorkingIndicator } from "./brand";
import { getRestingIndicatorFrame } from "./working-indicator";

// A representative branded sequence, exercised here so the app only ships the
// generic resting-frame helper.
const EXAMPLE_INDICATOR: BrandWorkingIndicator = {
  frames: ["干", "千", "午", "牛", "丰", "生", "丰", "牛", "午", "千"],
  intervalMs: 90,
};

function frameAt(nowMs: number, indicator: BrandWorkingIndicator): string {
  const index = Math.floor(Math.max(0, nowMs) / indicator.intervalMs) % indicator.frames.length;
  return indicator.frames[index] ?? indicator.frames[0];
}

describe("working indicator", () => {
  test("advances one frame per interval and wraps", () => {
    expect(frameAt(0, EXAMPLE_INDICATOR)).toBe("干");
    expect(frameAt(89, EXAMPLE_INDICATOR)).toBe("干");
    expect(frameAt(90, EXAMPLE_INDICATOR)).toBe("千");
    expect(frameAt(180, EXAMPLE_INDICATOR)).toBe("午");
    expect(frameAt(810, EXAMPLE_INDICATOR)).toBe("千");
    expect(frameAt(900, EXAMPLE_INDICATOR)).toBe("干");
  });

  test("rests on the title mark, or the settled last frame", () => {
    expect(getRestingIndicatorFrame(EXAMPLE_INDICATOR, "千")).toBe("千");
    expect(getRestingIndicatorFrame(EXAMPLE_INDICATOR, null)).toBe("千");
  });
});
