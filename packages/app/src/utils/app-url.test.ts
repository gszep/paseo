import { describe, expect, it } from "vitest";
import { pairingAppUrl } from "./app-url";

describe("hosted pairing links", () => {
  it("preserves the exact offer when changing the presentation origin", () => {
    expect(pairingAppUrl("https://app.paseo.sh/#offer=abc_-123", "https://chi.example.com")).toBe(
      "https://chi.example.com/#offer=abc_-123",
    );
  });

  it("keeps native/default and unavailable offers unchanged", () => {
    expect(pairingAppUrl("https://app.paseo.sh/#offer=abc", "")).toBe(
      "https://app.paseo.sh/#offer=abc",
    );
    expect(pairingAppUrl("", "https://chi.example.com")).toBe("");
  });
});
