import jsQR from "jsqr";

interface QrDetector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}

interface QrDetectorConstructor {
  new (options: { formats: string[] }): QrDetector;
  getSupportedFormats(): Promise<string[]>;
}

async function createDetector(): Promise<QrDetector | null> {
  const browser: typeof globalThis & { BarcodeDetector?: QrDetectorConstructor } = globalThis;
  if (!browser.BarcodeDetector) return null;
  try {
    const formats = await browser.BarcodeDetector.getSupportedFormats();
    return formats.includes("qr_code")
      ? new browser.BarcodeDetector({ formats: ["qr_code"] })
      : null;
  } catch {
    return null;
  }
}

interface CameraSessionOptions {
  video: HTMLVideoElement;
  onScan: (text: string) => void;
  onError: (error: unknown) => void;
}

/** Owns pending acquisitions too: a stream arriving after stop is immediately closed. */
export function startPairingCamera({ video, onScan, onError }: CameraSessionOptions): () => void {
  let stopped = false;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  function stop() {
    stopped = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }

  async function start() {
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (stopped) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      video.srcObject = stream;
      await video.play();
      let detector = await createDetector();

      async function scan() {
        if (stopped) return;
        try {
          if (video.readyState >= 2 && video.videoWidth > 0) {
            let text: string | undefined;
            if (detector) {
              try {
                const codes = await detector.detect(video);
                text = codes[0]?.rawValue;
              } catch {
                // Some browsers expose the API but cannot decode this video source.
                detector = null;
              }
            }
            if (!detector && context) {
              const scale = Math.min(1, 960 / video.videoWidth);
              canvas.width = Math.round(video.videoWidth * scale);
              canvas.height = Math.round(video.videoHeight * scale);
              context.drawImage(video, 0, 0, canvas.width, canvas.height);
              const image = context.getImageData(0, 0, canvas.width, canvas.height);
              text = jsQR(image.data, image.width, image.height)?.data;
            }
            if (!stopped && text) onScan(text);
          }
          if (!stopped) timer = setTimeout(scan, 300);
        } catch (error) {
          if (!stopped) {
            stop();
            onError(error);
          }
        }
      }
      if (!stopped) void scan();
    } catch (error) {
      if (!stopped) {
        stop();
        onError(error);
      }
    }
  }
  void start();
  return stop;
}
