import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import QRCode from "qrcode";

// A real Y4M camera frame, generated without ffmpeg or checked-in binary fixtures.
async function qrVideo(directory: string, text: string): Promise<string> {
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
  const video = path.join(directory, "qr.y4m");
  await writeFile(
    video,
    Buffer.concat([
      Buffer.from(`YUV4MPEG2 W${size} H${size} F5:1 Ip A1:1 C420jpeg\n`),
      frame,
      frame,
    ]),
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
    const video = await qrVideo(directory, `${prefix}#offer=${encoded}`);
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
      await expect(page.getByRole("alert")).toContainText("Invalid input");
      await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible();
      await expect(page.locator("video")).toHaveCount(0);
      await page.getByRole("button", { name: "Scan again" }).click();
      await expect(page.getByRole("alert")).toContainText("Invalid input");
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
