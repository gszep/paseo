import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { hostingConfig, serviceWorker } from "../../scripts/prepare-hosted-web.mjs";

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
