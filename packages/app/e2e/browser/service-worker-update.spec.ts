import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { serviceWorkerRegistration } from "../../scripts/service-worker.mjs";

/**
 * The hosted build's update controller is plain page JavaScript, so it can be
 * exercised in a real browser without shipping the whole app: a local harness
 * provides a mock ServiceWorkerRegistration and the release it can install.
 */
function harnessHtml(registrationScript: string): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>SW update harness</title></head>
  <body>
    <textarea id="draft"></textarea>
    <script>
      window.__visibility = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => window.__visibility,
      });
      // The controller's idle gate reads Date.now(); the test drives it directly.
      window.__now = 1000000;
      Date.now = () => window.__now;

      window.__loads = (Number(localStorage.getItem("sw-loads")) || 0) + 1;
      localStorage.setItem("sw-loads", String(window.__loads));
      const draft = document.getElementById("draft");
      draft.value = localStorage.getItem("sw-draft") || "";
      draft.addEventListener("input", () => localStorage.setItem("sw-draft", draft.value));

      const listeners = {};
      const registration = {
        installing: null,
        waiting: null,
        active: { state: "activated" },
        addEventListener(type, handler) {
          (listeners[type] ||= []).push(handler);
        },
        update() {
          return Promise.resolve();
        },
      };
      Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: {
          controller: {},
          addEventListener(type, handler) {
            (listeners["sw:" + type] ||= []).push(handler);
          },
          register() {
            return Promise.resolve(registration);
          },
        },
      });
      window.__triggerUpdate = () => {
        const worker = {
          state: "installing",
          handlers: [],
          addEventListener(_type, handler) {
            this.handlers.push(handler);
          },
        };
        registration.installing = worker;
        for (const handler of listeners.updatefound || []) handler();
        worker.state = "installed";
        for (const handler of worker.handlers) handler();
        for (const handler of listeners["sw:controllerchange"] || []) handler();
      };
      window.__setVisibility = (value) => {
        window.__visibility = value;
        document.dispatchEvent(new Event("visibilitychange"));
      };
    </script>
    <script>${registrationScript}</script>
  </body>
</html>
`;
}

async function startHarness() {
  const html = harnessHtml(serviceWorkerRegistration());
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface HarnessWindow {
  __triggerUpdate(): void;
  __setVisibility(value: "visible" | "hidden"): void;
  __now: number;
}

test("a new release never reloads while typing and applies once hidden", async ({ page }) => {
  const harness = await startHarness();
  try {
    await page.goto(harness.url);
    expect(await page.evaluate(() => Number(localStorage.getItem("sw-loads")))).toBe(1);

    await page.locator("#draft").fill("half-written mention draft");
    await page.evaluate(() => (window as unknown as HarnessWindow).__triggerUpdate());
    await page.waitForTimeout(500);
    // The control is focused: the installed release stays pending.
    expect(await page.evaluate(() => Number(localStorage.getItem("sw-loads")))).toBe(1);

    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      (window as unknown as HarnessWindow).__setVisibility("hidden");
    });
    await page.waitForFunction(() => Number(localStorage.getItem("sw-loads")) === 2, undefined, {
      timeout: 10000,
    });
    // Origin-local drafts survive the silent reload.
    expect(await page.evaluate(() => localStorage.getItem("sw-draft"))).toBe(
      "half-written mention draft",
    );
  } finally {
    await harness.close();
  }
});

test("a new release applies on idle with no focused control", async ({ page }) => {
  const harness = await startHarness();
  try {
    await page.goto(harness.url);
    await page.evaluate(() => (window as unknown as HarnessWindow).__triggerUpdate());
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => Number(localStorage.getItem("sw-loads")))).toBe(1);

    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      const harnessWindow = window as unknown as HarnessWindow;
      harnessWindow.__now += 120000;
      harnessWindow.__setVisibility("visible");
    });
    await page.waitForFunction(() => Number(localStorage.getItem("sw-loads")) === 2, undefined, {
      timeout: 10000,
    });
  } finally {
    await harness.close();
  }
});
