import { useEffect, useState } from "react";
import { isNative, isWeb } from "@/constants/platform";
import { isFdroidBuild } from "@/constants/build-profile";
import { cameraAvailability, canScanPairingQr } from "@/utils/pairing-camera";

export function usePairingCameraAvailable(visible: boolean): boolean {
  const [hasCamera, setHasCamera] = useState<boolean | null>(null);
  const hasGetUserMedia =
    isWeb && typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  useEffect(() => {
    if (!visible || !hasGetUserMedia) return;
    let active = true;
    const devices = navigator.mediaDevices;
    async function refresh() {
      try {
        const available = cameraAvailability(await devices.enumerateDevices());
        if (active) setHasCamera(available);
      } catch {
        // Enumeration can be permission-gated; opening the scanner owns the prompt.
        if (active) setHasCamera(null);
      }
    }
    void refresh();
    devices.addEventListener?.("devicechange", refresh);
    return () => {
      active = false;
      devices.removeEventListener?.("devicechange", refresh);
    };
  }, [visible, hasGetUserMedia]);
  return canScanPairingQr({ isNative, isFdroidBuild, hasGetUserMedia, hasCamera });
}
