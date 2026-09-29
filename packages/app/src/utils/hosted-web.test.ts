import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  applyBrandToHtml,
  applyBrandToManifest,
  brandAssetNames,
  brandRuntimeConfig,
  hostingConfig,
  parseBrandJson,
  serviceWorker,
} from "../../scripts/prepare-hosted-web.mjs";

const CHI_BRAND = {
  name: "Chi",
  mark: { viewBox: "0 0 1000 1000", paths: ["M0 0L1000 1000Z"] },
  workingIndicator: {
    frames: ["干", "千", "午", "牛", "丰", "生", "丰", "牛", "午", "千"],
    intervalMs: 90,
  },
  titleMark: "千",
  attribution: { label: "Powered by Paseo", url: "https://paseo.sh" },
  icons: {
    themeColor: "#181b1a",
    backgroundColor: "#181b1a",
    appleTouch: "apple-touch-icon.png",
    favicon: "favicon.ico",
    faviconPng: { light: "favicon-light.png", dark: "favicon-dark.png" },
    faviconStates: {
      light: {
        none: "favicon-light.png",
        running: "favicon-light-running.png",
        attention: "favicon-light-attention.png",
      },
      dark: {
        none: "favicon-dark.png",
        running: "favicon-dark-running.png",
        attention: "favicon-dark-attention.png",
      },
    },
    manifest: [
      { src: "pwa-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      {
        src: "pwa-icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  },
};

const INDEX_HTML = `<!doctype html><html><head><meta name="theme-color" content="#181B1A" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" /><title>Paseo</title></head><body><div id="root"></div></body></html>`;

describe("hosted brand inputs", () => {
  it("parses and normalizes a brand", () => {
    const brand = parseBrandJson(CHI_BRAND);
    expect(brand.name).toBe("Chi");
    expect(brand.workingIndicator).toEqual(CHI_BRAND.workingIndicator);
    expect(brand.icons!.manifest).toHaveLength(2);
  });

  it("rejects path traversal and malformed icons", () => {
    expect(() => parseBrandJson({ ...CHI_BRAND, name: "<script>" })).toThrow();
    expect(() =>
      parseBrandJson({
        ...CHI_BRAND,
        icons: { ...CHI_BRAND.icons, appleTouch: "../secret.png" },
      }),
    ).toThrow();
    expect(() =>
      parseBrandJson({
        ...CHI_BRAND,
        icons: { ...CHI_BRAND.icons, manifest: [{ src: "a.png", sizes: "big" }] },
      }),
    ).toThrow();
  });

  it("lists every referenced asset", () => {
    const names = brandAssetNames(parseBrandJson(CHI_BRAND));
    expect(names).toContain("pwa-icon-maskable-512.png");
    expect(names).toContain("favicon-dark-attention.png");
    expect(names).toContain("favicon.ico");
  });

  it("rewrites manifest name, colours and icons with /brand URLs", () => {
    const manifest = applyBrandToManifest({ name: "Paseo", icons: [] }, parseBrandJson(CHI_BRAND));
    expect(manifest.name).toBe("Chi");
    expect(manifest.theme_color).toBe("#181b1a");
    expect(manifest.icons[0]).toEqual({
      src: "/brand/pwa-icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    });
  });

  it("injects the runtime brand and icon links into the shell", () => {
    const html = applyBrandToHtml(INDEX_HTML, parseBrandJson(CHI_BRAND));
    expect(html).toContain("<title>Chi</title>");
    expect(html).toContain('<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />');
    expect(html).toContain('content="#181b1a"');
    expect(html).toContain("globalThis.__PASEO_BRAND__=");
    expect(html).toContain('globalThis.__PASEO_BRAND__={"name":"Chi"');
    expect(html).toContain('<script src="/register-sw.js" defer></script></head>');
  });

  it("exposes a runtime brand with favicon URLs and attribution", () => {
    const runtime = brandRuntimeConfig(parseBrandJson(CHI_BRAND));
    expect(runtime!.favicons!.light.running).toBe("/brand/favicon-light-running.png");
    expect(runtime!.attribution).toEqual({ label: "Powered by Paseo", url: "https://paseo.sh" });
  });

  it("rejects an insecure attribution URL", () => {
    expect(() =>
      parseBrandJson({
        ...CHI_BRAND,
        attribution: { label: "Powered by Paseo", url: "http://paseo.sh" },
      }),
    ).toThrow();
  });

  it("leaves the default build untouched when no brand is supplied", () => {
    expect(brandRuntimeConfig(null)).toBeNull();
    expect(applyBrandToManifest({ name: "Paseo" }, null)).toEqual({ name: "Paseo" });
    const html = applyBrandToHtml(INDEX_HTML, null);
    expect(html).toContain("<title>Paseo</title>");
    expect(html).not.toContain("__PASEO_BRAND__");
  });
});

describe("hosted export policy", () => {
  const env = {
    EXPO_PUBLIC_PASEO_APP_BASE_URL: "https://app.example.com",
    PASEO_WEB_RELAY_URL: "wss://relay.example.com",
    PASEO_WEB_NAME: "Chi",
  };
  it("accepts explicit secure root hosting without changing the relay", () => {
    expect(hostingConfig(env)).toEqual({
      base: "https://app.example.com",
      relay: "wss://relay.example.com",
      name: "Chi",
    });
  });
  it.each([
    "http://app.example.com",
    "https://app.example.com/subpath",
    "https://user:pass@app.example.com",
    "https://app.example.com/?query",
  ])("rejects unsafe or unsupported base %s", (base) => {
    expect(() => hostingConfig({ ...env, EXPO_PUBLIC_PASEO_APP_BASE_URL: base })).toThrow();
  });
  it("requires an exact WSS relay origin and plain app name", () => {
    expect(() =>
      hostingConfig({ ...env, PASEO_WEB_RELAY_URL: "ws://relay.example.com" }),
    ).toThrow();
    expect(() => hostingConfig({ ...env, PASEO_WEB_NAME: "<script>" })).toThrow();
  });
  it("only intercepts app navigation and explicitly listed static assets", () => {
    const worker = serviceWorker("test", ["/assets/abc123.js"], ["/index.html", "/register-sw.js"]);
    const registry: Record<string, unknown> = {};
    const handles = (url: string, mode = "cors", method = "GET") =>
      runInNewContext(
        `${worker}
      let handled = false;
      handlers.fetch({ request: { url, mode, method }, respondWith() { handled = true; } });
      handled;
    `,
        {
          URL,
          url,
          mode,
          method,
          handlers: registry,
          self: {
            location: { origin: "https://app.example.com" },
            addEventListener: (type: string, handler: unknown) => {
              registry[type] = handler;
            },
          },
          caches: {
            open: async () => ({ match: async () => new Response("cached") }),
            match: async () => new Response("offline"),
          },
          fetch: async () => new Response("online"),
          Response,
        },
      );
    expect(handles("https://app.example.com/h/host/workspace/workspace", "navigate")).toBe(true);
    expect(handles("https://app.example.com/register-sw.js")).toBe(true);
    expect(handles("https://app.example.com/assets/abc123.js")).toBe(true);
    expect(handles("https://app.example.com/api/agents", "navigate")).toBe(false);
    expect(handles("https://app.example.com/api", "navigate")).toBe(false);
    expect(handles("https://relay.example.com/traffic")).toBe(false);
    expect(handles("https://app.example.com/unknown.json")).toBe(false);
    expect(handles("https://app.example.com/assets/abc123.js?token=private")).toBe(false);
    expect(handles("https://app.example.com/assets/abc123.js", "cors", "POST")).toBe(false);
  });

  it("activates immediately, claims open windows, and cleans only older shell caches", async () => {
    const worker = serviceWorker("test", [], ["/index.html"]);
    const calls: { added: number; skipped: boolean; deleted: string[]; claimed: boolean } = {
      added: 0,
      skipped: false,
      deleted: [],
      claimed: false,
    };
    const handlers: Record<
      string,
      (event: { waitUntil(promise: Promise<unknown>): void }) => void
    > = {};
    await runInNewContext(
      `(async () => {
        ${worker}
        await new Promise((resolve) => { handlers.install({ waitUntil: (promise) => resolve(promise) }); });
        await new Promise((resolve) => { handlers.activate({ waitUntil: (promise) => resolve(promise) }); });
        handlers.message({ data: { type: "SKIP_WAITING" } });
      })()`,
      {
        URL,
        Request: class {
          constructor(
            public url: string,
            public init?: unknown,
          ) {}
        },
        Response,
        handlers,
        caches: {
          open: async () => ({
            addAll: async () => {
              calls.added++;
            },
          }),
          keys: async () => ["paseo-shell-old", "paseo-shell-test", "unrelated"],
          delete: async (key: string) => {
            calls.deleted.push(key);
          },
        },
        self: {
          location: { origin: "https://app.example.com" },
          addEventListener: (type: string, handler: unknown) => {
            handlers[type] = handler as (event: {
              waitUntil(promise: Promise<unknown>): void;
            }) => void;
          },
          skipWaiting: () => {
            calls.skipped = true;
            return Promise.resolve();
          },
          clients: {
            claim: async () => {
              calls.claimed = true;
            },
          },
        },
        calls,
      },
    );
    expect(calls.added).toBe(1);
    expect(calls.skipped).toBe(true);
    expect(calls.deleted).toEqual(["paseo-shell-old"]);
    expect(calls.claimed).toBe(true);
    expect(handlers.message).toBeDefined();
  });
});
