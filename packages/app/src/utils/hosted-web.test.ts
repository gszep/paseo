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
});
