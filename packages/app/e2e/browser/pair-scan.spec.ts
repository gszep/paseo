import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import { startLocalWorkerRelay } from "../support/helpers/local-worker-relay";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { generateLocalPairingOffer } from "../../../server/src/server/pairing-offer";

// A real Y4M camera frame, generated without ffmpeg or checked-in binary fixtures.
function qrFrame(text: string): Buffer {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" }).modules;
  const size = 640;
  const pixels = Buffer.alloc(size * size, 235);
  const scale = Math.floor(size / (qr.size + 8));
  const offset = Math.floor((size - qr.size * scale) / 2);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.get(y, x)) continue;
      for (let row = 0; row < scale; row++) {
        const start = (offset + y * scale + row) * size + offset + x * scale;
        pixels.fill(16, start, start + scale);
      }
    }
  }
  const frame = Buffer.concat([
    Buffer.from("FRAME\n"),
    pixels,
    Buffer.alloc((size * size) / 2, 128),
  ]);
  return frame;
}

async function qrVideo(directory: string, texts: string[]): Promise<string> {
  const video = path.join(directory, "qr.y4m");
  const frames = texts.flatMap((text) => Array<Buffer>(20).fill(qrFrame(text)));
  await writeFile(
    video,
    Buffer.concat([Buffer.from("YUV4MPEG2 W640 H640 F5:1 Ip A1:1 C420jpeg\n"), ...frames]),
  );
  return video;
}

for (const prefix of ["https://app.paseo.sh/", "https://hosted.example.com/"]) {
  test(`web camera fallback decodes ${prefix} QR and displays validation failure`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-qr-"));
    // Invalid version proves decoding reaches the real pairing schema without contacting a relay.
    const encoded = Buffer.from(
      JSON.stringify({
        v: 1,
        serverId: "test",
        daemonPublicKeyB64: "test",
        relay: { endpoint: "localhost:1" },
      }),
    ).toString("base64url");
    const video = await qrVideo(directory, [
      "https://example.com/unrelated-menu",
      `${prefix}#offer=${encoded}`,
    ]);
    const browser = await chromium.launch({
      args: [
        "--disable-blink-features=BarcodeDetector",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-video-capture=${video}`,
      ],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(`http://localhost:${process.env.E2E_METRO_PORT}/pair-scan`);
      expect(await page.evaluate(() => "BarcodeDetector" in globalThis)).toBe(false);
      await expect(page.getByTestId("pair-link-modal")).toBeVisible();
      await expect(page.getByTestId("pair-link-input")).toHaveValue(`${prefix}#offer=${encoded}`);
      await expect(page.getByText(/Invalid input/)).toHaveCount(0);
      await expect(page.locator("video")).toHaveCount(0);
      await page.getByTestId("pair-link-submit").click();
      await expect(page.getByText(/Invalid input/)).toBeVisible();
    } finally {
      await browser.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("denied camera access shows the permission UI", async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream=deny"],
  });
  const context = await browser.newContext({ permissions: [] });
  try {
    const page = await context.newPage();
    await page.goto(`http://localhost:${process.env.E2E_METRO_PORT}/pair-scan`);
    await expect(page.getByText("Camera permission", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Grant permission" })).toBeVisible();
    await expect(
      page.getByText(/Allow camera access in your browser's site settings/),
    ).toBeVisible();
  } finally {
    await context.close();
    await browser.close();
  }
});

test("camera tracks stop when navigating away from the scanner", async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${process.env.E2E_METRO_PORT}/`);
    await expect(page.getByTestId("welcome-scan-qr")).toBeVisible();
    await page.getByTestId("welcome-open-settings").click();
    await page.getByTestId("settings-add-host").click();
    const scan = page.getByRole("button", { name: "Scan QR code", exact: true });
    await expect(scan).toBeVisible();
    expect(
      await page.evaluate(
        async () => (await navigator.permissions.query({ name: "camera" })).state,
      ),
    ).toBe("prompt");
    await scan.click();
    await page.waitForFunction(() => document.querySelector("video")?.readyState === 4);
    const track = await page.evaluateHandle(() => {
      const stream = document.querySelector("video")?.srcObject;
      if (!(stream instanceof MediaStream)) throw new Error("Camera stream was not attached");
      return stream.getVideoTracks()[0];
    });
    expect(await track.evaluate((value) => value.readyState)).toBe("live");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.locator("video")).toHaveCount(0);
    expect(await track.evaluate((value) => value.readyState)).toBe("ended");
  } finally {
    await browser.close();
  }
});

test("scanned offers connect and persist only after Pair; Cancel has no side effects", async () => {
  test.setTimeout(150_000);
  const relay = await startLocalWorkerRelay();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-confirm-qr-"));
  const daemon = await startIsolatedHostDaemon("qr-confirmation-host", {
    mutableRelay: { enabled: true, endpoint: relay.endpoint },
  });
  try {
    const offer = await generateLocalPairingOffer({
      paseoHome: daemon.paseoHome,
      relayEndpoint: relay.endpoint,
      relayUseTls: false,
      includeQr: false,
    });
    if (!offer.url) throw new Error("Missing real daemon offer");
    const video = await qrVideo(directory, [offer.url]);
    const browser = await chromium.launch({
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-video-capture=${video}`,
      ],
    });
    try {
      const page = await browser.newPage();
      const connections: string[] = [];
      page.on("websocket", (socket) => {
        if (socket.url().startsWith(`ws://${relay.endpoint}/`)) connections.push(socket.url());
      });
      await page.goto(`http://localhost:${process.env.E2E_METRO_PORT}/`);
      await page.getByTestId("welcome-scan-qr").click();
      await expect(page.getByTestId("pair-link-target")).toContainText(`Host: ${daemon.serverId}`);
      await expect(page.getByTestId("pair-link-target")).toContainText(`Relay: ${relay.endpoint}`);
      expect(connections).toEqual([]);
      expect(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem("@paseo:daemon-registry") ?? "[]"),
        ),
      ).toEqual([]);
      await page.getByTestId("pair-link-cancel").click();
      await expect(page.getByTestId("welcome-scan-qr")).toBeVisible();
      expect(connections).toEqual([]);
      expect(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem("@paseo:daemon-registry") ?? "[]"),
        ),
      ).toEqual([]);

      await page.getByTestId("welcome-scan-qr").click();
      await expect(page.getByTestId("pair-link-target")).toContainText(`Host: ${daemon.serverId}`);
      expect(connections).toEqual([]);
      await page.getByTestId("pair-link-submit").click();
      await expect(page.getByTestId("pair-link-modal")).toHaveCount(0);
      await expect.poll(() => connections.length).toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("@paseo:daemon-registry")))
        .toContain(daemon.serverId);
      await page.reload();
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("@paseo:daemon-registry")))
        .toContain(daemon.serverId);
    } finally {
      await browser.close();
    }
  } finally {
    await daemon.close();
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("device termination stops capture, shows retry, and disposes old track listeners", async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${process.env.E2E_METRO_PORT}/pair-scan`);
    await page.waitForFunction(() => document.querySelector("video")?.readyState === 4);
    const track = await page.evaluateHandle(() => {
      const stream = document.querySelector("video")?.srcObject;
      if (!(stream instanceof MediaStream)) throw new Error("Missing stream");
      return stream.getVideoTracks()[0];
    });
    // Browser dispatches this event on device removal; stop() alone does not emit it.
    await track.evaluate((value) => value.dispatchEvent(new Event("ended")));
    await expect(page.getByText(/The camera could not be opened/)).toBeVisible();
    expect(await track.evaluate((value) => value.readyState)).toBe("ended");
    expect(
      await page
        .locator("video")
        .evaluate((video) => video instanceof HTMLVideoElement && video.srcObject === null),
    ).toBe(true);
    await page.getByRole("button", { name: "Grant permission" }).click();
    await page.waitForFunction(() => document.querySelector("video")?.readyState === 4);
    await track.evaluate((value) => value.dispatchEvent(new Event("ended")));
    await expect(page.getByText(/The camera could not be opened/)).toHaveCount(0);
    expect(
      await page
        .locator("video")
        .evaluate(
          (video) =>
            video instanceof HTMLVideoElement &&
            video.srcObject instanceof MediaStream &&
            video.srcObject.active,
        ),
    ).toBe(true);
  } finally {
    await browser.close();
  }
});

test("page suspension stops capture and restoration acquires a new stream", async () => {
  const browser = await chromium.launch({
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${process.env.E2E_METRO_PORT}/pair-scan`);
    await page.waitForFunction(() => document.querySelector("video")?.readyState === 4);
    const track = await page.evaluateHandle(() => {
      const stream = document.querySelector("video")?.srcObject;
      if (!(stream instanceof MediaStream)) throw new Error("Missing stream");
      return stream.getVideoTracks()[0];
    });
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    expect(await track.evaluate((value) => value.readyState)).toBe("ended");
    expect(
      await page
        .locator("video")
        .evaluate((video) => video instanceof HTMLVideoElement && video.srcObject === null),
    ).toBe(true);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await page.waitForFunction(() => document.querySelector("video")?.readyState === 4);
    expect(
      await track.evaluate((value) => {
        const stream = document.querySelector("video")?.srcObject;
        return (
          stream instanceof MediaStream &&
          stream.active &&
          stream.getVideoTracks()[0].id !== value.id
        );
      }),
    ).toBe(true);
  } finally {
    await browser.close();
  }
});
