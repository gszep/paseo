interface ScanCapability {
  isNative: boolean;
  isFdroidBuild: boolean;
  hasGetUserMedia: boolean;
  hasCamera: boolean | null;
}

export function canScanPairingQr(capability: ScanCapability): boolean {
  if (capability.isNative) return !capability.isFdroidBuild;
  return capability.hasGetUserMedia && capability.hasCamera !== false;
}

// Empty results can mean that the browser conceals devices before permission.
export function cameraAvailability(
  devices: ReadonlyArray<Pick<MediaDeviceInfo, "kind">>,
): boolean | null {
  if (devices.length === 0) return null;
  return devices.some((device) => device.kind === "videoinput");
}
