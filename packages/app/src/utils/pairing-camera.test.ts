import { describe, expect, it } from "vitest";
import { cameraAvailability, canScanPairingQr } from "./pairing-camera";

describe("pairing QR option", () => {
  it.each([
    [true, false, false, null, true],
    [true, true, true, true, false],
    [false, false, false, null, false],
    [false, false, true, null, true],
    [false, false, true, true, true],
    [false, false, true, false, false],
  ] as const)(
    "native=%s fdroid=%s media=%s camera=%s → %s",
    (isNative, isFdroidBuild, hasGetUserMedia, hasCamera, expected) => {
      expect(canScanPairingQr({ isNative, isFdroidBuild, hasGetUserMedia, hasCamera })).toBe(
        expected,
      );
    },
  );

  it("distinguishes unknown device enumeration from a known audio-only device list", () => {
    expect(cameraAvailability([])).toBe(null);
    expect(cameraAvailability([{ kind: "audioinput" }])).toBe(false);
    expect(cameraAvailability([{ kind: "videoinput" }])).toBe(true);
  });
});
