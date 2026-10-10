import { test, expect } from "@playwright/test";
import path from "node:path";
import { z } from "zod";
import { buildSeededHost } from "../support/helpers/daemon-registry";
import { spawnTsx, killProcessTree } from "../support/helpers/spawn-node";

test("workspace activity previews load before the catalog on desktop and mobile web", async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
  const root = path.resolve(__dirname, "../../../..");
  const child = spawnTsx(
    path.join(root, "packages/server/src/server/test-utils/chi-inbox.ts"),
    [origin],
    {
      cwd: root,
      env: { ...process.env, PASEO_SUPERVISED: "0" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics = (diagnostics + String(chunk)).slice(-8000);
  });
  try {
    const host = await new Promise<{ serverId: string; port: number }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Inbox fixture startup timed out: ${diagnostics}`)),
        30_000,
      );
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Inbox fixture exited ${code}: ${diagnostics}`));
      });
      child.once("message", (value) => {
        clearTimeout(timer);
        resolve(z.object({ serverId: z.string(), port: z.number() }).parse(value));
      });
    });
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1280, height: 900 },
    ]) {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const savedHost = buildSeededHost({
          serverId: host.serverId,
          endpoint: `127.0.0.1:${host.port}`,
          label: "Fixture",
          nowIso: new Date().toISOString(),
        });
        await page.addInitScript((value) => {
          localStorage.setItem("@paseo:e2e", "1");
          localStorage.setItem("@paseo:daemon-registry", JSON.stringify([value]));
        }, savedHost);
        await page.goto(`${origin}/chi?view=inbox`);
        await expect(page.getByText("Release planning", { exact: true })).toBeVisible();
        await expect(
          page.getByTestId("chi-flat-inbox").locator('[data-testid^="mention-row-"]'),
        ).toHaveCount(3);
        const preview = page.getByTestId("mention-preview-00000000-0000-4000-8000-000000000000");
        await expect(preview).toBeVisible();
        const geometry = await preview.evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          line: Number.parseFloat(getComputedStyle(element).lineHeight),
          width: element.getBoundingClientRect().width,
        }));
        expect(geometry.height).toBeLessThanOrEqual(2 * geometry.line + 1);
        expect(geometry.width).toBeLessThan(viewport.width);
        await page.screenshot({
          path: testInfo.outputPath(`inbox-${viewport.width}.png`),
          fullPage: true,
        });
      } finally {
        await context.close();
      }
    }
    const stopped = new Promise<unknown>((resolve) => child.once("message", resolve));
    child.send("close");
    expect(await stopped).toEqual({ mutations: [] });
  } finally {
    await killProcessTree(child);
  }
});
