import { describe, expect, it } from "vitest";
import { scannedPairingOffer } from "./scanned-pairing-offer";

describe("shared native and web scan admission", () => {
  it.each(["", "  ", "https://example.com/menu", "WIFI:S:cafe;", "offer=abc"])(
    "ignores unrelated QR text %s",
    (text) => {
      expect(scannedPairingOffer(text)).toBeNull();
    },
  );
  it.each(["https://app.paseo.sh/", "https://hosted.example.com/"])(
    "stages %s without decoding or connecting",
    (prefix) => {
      expect(scannedPairingOffer(`  ${prefix}#offer=abc\n`)).toBe(`${prefix}#offer=abc`);
    },
  );
});
