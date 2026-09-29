import { describe, expect, test } from "vitest";
import { formatWindowTitle } from "./window-title";

describe("window title", () => {
  test("leaves the label alone for the default brand", () => {
    expect(formatWindowTitle({ titleMark: null, mark: "千", label: "Fix the flaky test" })).toBe(
      "Fix the flaky test",
    );
  });

  test("prefixes a branded label with the mark", () => {
    expect(formatWindowTitle({ titleMark: "千", mark: "千", label: "Fix the flaky test" })).toBe(
      "千-Fix the flaky test",
    );
  });

  test("renders the live frame while working", () => {
    expect(formatWindowTitle({ titleMark: "千", mark: "干", label: "Fix the flaky test" })).toBe(
      "干-Fix the flaky test",
    );
  });

  test("trims the label and names an empty branded session", () => {
    expect(formatWindowTitle({ titleMark: "千", mark: "千", label: "  spaced  " })).toBe(
      "千-spaced",
    );
    expect(formatWindowTitle({ titleMark: "千", mark: "千", label: "   " })).toBe(
      "千-Untitled session",
    );
  });
});
