import { afterEach, describe, expect, it, vi } from "vitest";

/** A minimal injected brand; parseBrandConfig fills the optional fields. */
const CHI_BRAND = {
  name: "Chi",
  mark: { viewBox: "0 0 100 100", paths: ["M0 0L100 100Z"] },
};

async function loadI18n() {
  vi.resetModules();
  return import("./i18next");
}

afterEach(() => {
  delete (globalThis as { __PASEO_BRAND__?: unknown }).__PASEO_BRAND__;
});

describe("brand-aware onboarding copy", () => {
  it("renders the default Paseo name when no brand is injected", async () => {
    const { i18n } = await loadI18n();
    expect(i18n.t("onboarding.title")).toBe("Welcome to Paseo");
    expect(i18n.t("pairing.device.hint")).toBe(
      "Scan this QR code with Paseo on your phone, or copy the link below.",
    );
  });

  it("renders the injected brand name", async () => {
    (globalThis as { __PASEO_BRAND__?: unknown }).__PASEO_BRAND__ = CHI_BRAND;
    const { i18n } = await loadI18n();
    expect(i18n.t("onboarding.title")).toBe("Welcome to Chi");
    expect(i18n.t("pairing.device.hint")).toBe(
      "Scan this QR code with Chi on your phone, or copy the link below.",
    );
  });
});
