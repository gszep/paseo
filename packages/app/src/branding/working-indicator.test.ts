import { describe, expect, test } from "vitest";
import {
  CHI_WORKING_INDICATOR,
  getRestingIndicatorFrame,
  getWorkingIndicatorFrame,
} from "./working-indicator";

describe("working indicator", () => {
  test("reuses the chi-theme kanji sequence and 90ms cadence", () => {
    expect(CHI_WORKING_INDICATOR.frames).toEqual([
      "干",
      "千",
      "午",
      "牛",
      "丰",
      "生",
      "丰",
      "牛",
      "午",
      "千",
    ]);
    expect(CHI_WORKING_INDICATOR.intervalMs).toBe(90);
  });

  test("advances one frame per interval and wraps", () => {
    const indicator = CHI_WORKING_INDICATOR;
    expect(getWorkingIndicatorFrame(0, indicator)).toBe("干");
    expect(getWorkingIndicatorFrame(89, indicator)).toBe("干");
    expect(getWorkingIndicatorFrame(90, indicator)).toBe("千");
    expect(getWorkingIndicatorFrame(180, indicator)).toBe("午");
    expect(getWorkingIndicatorFrame(810, indicator)).toBe("千");
    expect(getWorkingIndicatorFrame(900, indicator)).toBe("干");
  });

  test("rests on the title mark, or the settled last frame", () => {
    expect(getRestingIndicatorFrame(CHI_WORKING_INDICATOR, "千")).toBe("千");
    expect(getRestingIndicatorFrame(CHI_WORKING_INDICATOR, null)).toBe("千");
  });
});
