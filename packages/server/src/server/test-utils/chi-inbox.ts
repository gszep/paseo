import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestPaseoDaemon } from "./paseo-daemon.js";

const origin = process.argv[2]!;
const repo = "github:fixture/activity";
let releaseCatalog!: () => void;
const catalog = new Promise<void>((resolve) => {
  releaseCatalog = resolve;
});
const mutations: string[] = [];
const handoffs = ["Release planning", "Mobile composer", "Research notes"].map(
  (workspaceName, index) => ({
    v: 3,
    id: `00000000-0000-4000-8000-00000000000${index}`,
    repo,
    author: "github:teammate",
    recipient: "github:reader",
    text: "Please review the deployment plan and confirm the next steps before we release the updated application. The remaining details are available in the discussion.",
    workspaceName,
    sources: [
      {
        pin: {
          v: 3,
          deployment: "fixture",
          repo,
          sourceId: "a".repeat(64),
          count: 1,
          head: "b".repeat(64),
        },
        seq: 0,
      },
    ],
    state: "open",
    revision: 1,
    createdAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
  }),
);
const host = await createTestPaseoDaemon({
  mcpEnabled: false,
  corsAllowedOrigins: [origin],
  chi: {
    destinations: { fixture: { name: "Fixture", endpoint: "https://chi.invalid" } },
    mappings: [{ repo, destination: "fixture", audience: "shared" }],
  },
  chiAuthority: {
    endpoint: "https://chi.invalid",
    invalidate() {},
    login: async () => ({
      sessionToken: "synthetic",
      chiUserId: "github:reader",
      credentialGeneration: "fixture",
    }),
    request: async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (init?.method && init.method !== "GET") mutations.push(pathname);
      if (pathname === "/auth/session")
        return Response.json({
          ok: true,
          chiUserId: "github:reader",
          capabilities: {
            appendLog: { v: 3, deployment: "fixture" },
            handoffs: { v: 3, references: "pin-seq" },
          },
        });
      if (pathname === "/repos") {
        await catalog;
        return Response.json({ ok: true, repos: [{ repo }] });
      }
      if (pathname === "/handoffs/inbox")
        return Response.json({
          handoffs,
          nextCursor: null,
          unreadCount: 3,
          unreadCountLowerBound: false,
        });
      throw new Error(`Unexpected fixture request ${pathname}`);
    },
  },
});
process.send?.({
  serverId: (await readFile(join(host.paseoHome, "server-id"), "utf8")).trim(),
  port: host.port,
});
process.on("message", async () => {
  releaseCatalog();
  await host.close();
  process.send?.({ mutations });
  process.disconnect?.();
});
