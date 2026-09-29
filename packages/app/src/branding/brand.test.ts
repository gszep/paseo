import { afterEach, describe, expect, test } from "vitest";
import { BRAND, PASEO_BRAND, parseBrandConfig, resolveBrandConfig } from "./brand";

// A complete example brand, used to exercise parsing and defaults.
const EXAMPLE_BRAND = {
  name: "Example",
  mark: { viewBox: "0 0 1000 1000", paths: ["M0 0L1000 1000Z"] },
  workingIndicator: {
    frames: ["a", "b", "c"],
    intervalMs: 90,
  },
  titleMark: "E",
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
  attribution: { label: "Powered by Example", url: "https://example.com" },
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
    expect(PASEO_BRAND.attribution).toBeNull();
  });

  test("parses a full brand and fills optional fields", () => {
    const brand = parseBrandConfig(EXAMPLE_BRAND);
    expect(brand.name).toBe("Example");
    expect(brand.titleMark).toBe("E");
    expect(brand.workingIndicator).toEqual(EXAMPLE_BRAND.workingIndicator);
    expect(brand.favicons?.dark.running).toBe("/brand/favicon-dark-running.png");
    expect(brand.attribution).toEqual({ label: "Powered by Example", url: "https://example.com" });
  });

  test("fills null working indicator, title mark, favicons and attribution", () => {
    const brand = parseBrandConfig({
      ...EXAMPLE_BRAND,
      workingIndicator: null,
      titleMark: null,
      favicons: null,
      attribution: null,
    });
    expect(brand.workingIndicator).toBeNull();
    expect(brand.titleMark).toBeNull();
    expect(brand.favicons).toBeNull();
    expect(brand.attribution).toBeNull();
  });

  test("resolves an injected brand", () => {
    (globalThis as { __PASEO_BRAND__?: unknown }).__PASEO_BRAND__ = EXAMPLE_BRAND;
    expect(resolveBrandConfig().name).toBe("Example");
  });

  test.each([
    [{ ...EXAMPLE_BRAND, name: "<script>" }],
    [{ ...EXAMPLE_BRAND, mark: { viewBox: "", paths: [] } }],
    [{ ...EXAMPLE_BRAND, workingIndicator: { frames: [], intervalMs: 90 } }],
    [{ ...EXAMPLE_BRAND, workingIndicator: { frames: ["a"], intervalMs: 0 } }],
    [{ ...EXAMPLE_BRAND, favicons: { light: {}, dark: {} } }],
    [
      {
        ...EXAMPLE_BRAND,
        favicons: {
          ...EXAMPLE_BRAND.favicons,
          light: { ...EXAMPLE_BRAND.favicons.light, none: "/brand//evil.png" },
        },
      },
    ],
    [
      {
        ...EXAMPLE_BRAND,
        favicons: {
          ...EXAMPLE_BRAND.favicons,
          light: { ...EXAMPLE_BRAND.favicons.light, none: "/brand/evil\\path.png" },
        },
      },
    ],
    [
      {
        ...EXAMPLE_BRAND,
        favicons: {
          ...EXAMPLE_BRAND.favicons,
          light: { ...EXAMPLE_BRAND.favicons.light, none: "/brand/evil.png?x=1" },
        },
      },
    ],
    [
      {
        ...EXAMPLE_BRAND,
        favicons: {
          ...EXAMPLE_BRAND.favicons,
          light: { ...EXAMPLE_BRAND.favicons.light, none: "/brand/evil.png#frag" },
        },
      },
    ],
    [{ ...EXAMPLE_BRAND, attribution: { label: "", url: "https://example.com" } }],
    [{ ...EXAMPLE_BRAND, attribution: { label: "x", url: "http://example.com" } }],
  ])("rejects malformed input %#", (input) => {
    expect(() => parseBrandConfig(input)).toThrow();
  });
});
