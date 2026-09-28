import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
  type CameraMountError,
} from "expo-camera";
import { PairingCameraPermission } from "./pairing-camera-permission";

export interface PairingCameraProps {
  onScan: (text: string) => void;
  children: ReactNode;
}

const barcodeScannerSettings = { barcodeTypes: ["qr" as const] };
const cameraStyle = { flex: 1 };

export function PairingCamera({ onScan, children }: PairingCameraProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string>();
  const request = useCallback(() => {
    setError(undefined);
    void requestPermission().catch((cause: Error) => setError(cause.message));
  }, [requestPermission]);
  const scan = useCallback((result: BarcodeScanningResult) => onScan(result.data), [onScan]);
  const mountError = useCallback((event: CameraMountError) => setError(event.message), []);
  useEffect(() => {
    void requestPermission().catch((cause: Error) => setError(cause.message));
  }, [requestPermission]);
  if (!permission?.granted || error) {
    return <PairingCameraPermission onRequest={request} message={error} />;
  }
  return (
    <CameraView
      style={cameraStyle}
      facing="back"
      barcodeScannerSettings={barcodeScannerSettings}
      onBarcodeScanned={scan}
      onMountError={mountError}
    >
      {children}
    </CameraView>
  );
}
