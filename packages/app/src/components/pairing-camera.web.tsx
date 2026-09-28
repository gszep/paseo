import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { startPairingCamera } from "@/utils/pairing-camera-session.web";
import { PairingCameraPermission } from "./pairing-camera-permission";
import type { PairingCameraProps } from "./pairing-camera";

const videoStyle = { width: "100%", height: "100%", objectFit: "cover" as const };
const hiddenVideoStyle = { ...videoStyle, display: "none" };

export function PairingCamera({ onScan, children }: PairingCameraProps) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string>();
  const request = useCallback(() => {
    setError(undefined);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let stop = () => {};
    function suspend() {
      stop();
    }
    function resume() {
      stop();
      if (!element || document.visibilityState === "hidden") return;
      setError(undefined);
      stop = startPairingCamera({
        video: element,
        onScan,
        onError: (cause) => {
          const denied = cause instanceof DOMException && cause.name === "NotAllowedError";
          setError(
            t(denied ? "pairing.scan.browserPermissionBody" : "pairing.scan.cameraUnavailableBody"),
          );
        },
      });
    }
    resume();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", resume);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", resume);
    };
  }, [attempt, onScan, t]);
  return (
    <>
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        aria-label={t("pairing.scan.title")}
        style={error ? hiddenVideoStyle : videoStyle}
      />
      {!error ? children : null}
      {error ? <PairingCameraPermission message={error} onRequest={request} /> : null}
    </>
  );
}
