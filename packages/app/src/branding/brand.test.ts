import { afterEach, describe, expect, test } from "vitest";
import { BRAND, PASEO_BRAND, parseBrandConfig, resolveBrandConfig } from "./brand";

const CHI_INPUT = {
  name: "Chi",
  mark: { viewBox: "0 0 1000 1000", paths: ["M0 0L1000 1000Z"] },
  workingIndicator: {
    frames: ["干", "千", "午", "牛", "丰", "生", "丰", "牛", "午", "千"],
    intervalMs: 90,
  },
  titleMark: "千",
  favicons: {
    light: {
      none: "/brand/favicon-light.png",
      running: "/brand/favicon-light-running.png",
      attention: "/brand/favicon-light-attention.png",
    },
    dark: {
      none: "/brand/favicon-dark.png",
      running: "/brand/favicon-dark-running.png",
      attention: "/brand/favicon-dark-attention.png",
    },
  },
};

afterEach(() => {
  delete (globalThis as { __PASEO_BRAND__?: unknown }).__PASEO_BRAND__;
});

describe("brand config", () => {
  test("defaults to Paseo", () => {
    expect(BRAND).toBe(PASEO_BRAND);
    expect(PASEO_BRAND.name).toBe("Paseo");
    expect(PASEO_BRAND.titleMark).toBeNull();
    expect(PASEO_BRAND.workingIndicator).toBeNull();
  });

  test("parses a full brand and fills optional fields", () => {
    const brand = parseBrandConfig(CHI_INPUT);
    expect(brand.name).toBe("Chi");
    expect(brand.titleMark).toBe("千");
    expect(brand.workingIndicator).toEqual(CHI_INPUT.workingIndicator);
    expect(brand.favicons?.dark.running).toBe("/brand/favicon-dark-running.png");
  });

  test("fills null working indicator, title mark and favicons", () => {
    const brand = parseBrandConfig({
      ...CHI_INPUT,
      workingIndicator: null,
      titleMark: null,
      favicons: null,
    });
    expect(brand.workingIndicator).toBeNull();
    expect(brand.titleMark).toBeNull();
    expect(brand.favicons).toBeNull();
  });

  test("resolves an injected brand", () => {
    (globalThis as { __PASEO_BRAND__?: unknown }).__PASEO_BRAND__ = CHI_INPUT;
    expect(resolveBrandConfig().name).toBe("Chi");
  });

  test.each([
    [{ ...CHI_INPUT, name: "<script>" }],
    [{ ...CHI_INPUT, mark: { viewBox: "", paths: [] } }],
    [{ ...CHI_INPUT, workingIndicator: { frames: [], intervalMs: 90 } }],
    [{ ...CHI_INPUT, workingIndicator: { frames: ["干"], intervalMs: 0 } }],
    [{ ...CHI_INPUT, favicons: { light: {}, dark: {} } }],
  ])("rejects malformed input %#", (input) => {
    expect(() => parseBrandConfig(input)).toThrow();
  });
});
