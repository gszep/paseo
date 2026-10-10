import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestPaseoDaemon } from "./paseo-daemon.js";
import { createTestAgentClients } from "./fake-agent-client.js";
import { encodeEntry } from "@henkaku-center/chi-native/append-codec";

const origin = process.argv[2]!;
const repo = "github:fixture/activity";
const conversation = process.argv[3] === "conversation";
let denied = false;
let unavailable = false;
const pageStarts: number[] = [];
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
          count: conversation ? 40 : 1,
          head: "b".repeat(64),
        },
        seq: conversation ? 27 : 0,
      },
    ],
    state: "open",
    revision: 1,
    readAt: conversation && index === 0 ? "2020-01-01T00:00:00Z" : undefined,
    createdAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
  }),
);
const host = await createTestPaseoDaemon({
  mcpEnabled: false,
  agentClients: createTestAgentClients(),
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
      const target = new URL(String(url));
      const pathname = target.pathname;
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
        if (!conversation) await catalog;
        return Response.json({ ok: true, repos: [{ repo }] });
      }
      if (conversation && denied) return Response.json({ reason: "forbidden" }, { status: 403 });
      if (pathname === "/handoffs/inbox")
        return Response.json({
          handoffs,
          nextCursor: null,
          unreadCount: conversation ? 2 : 3,
          unreadCountLowerBound: false,
        });
      if (conversation && pathname === "/handoffs")
        return Response.json({
          ok: true,
          handoff: handoffs.find((entry) => entry.id === target.searchParams.get("id")),
        });
      if (conversation && pathname === "/evidence/entries") {
        if (unavailable)
          return Response.json({ reason: "temporarily-unavailable" }, { status: 503 });
        const pin = JSON.parse(target.searchParams.get("pin")!);
        if (JSON.stringify(pin) !== JSON.stringify(handoffs[0]!.sources[0]!.pin))
          throw new Error("Fixture pin advanced");
        const start = Number(target.searchParams.get("start"));
        const end = Number(target.searchParams.get("end"));
        if (start < 0 || end > 40 || end - start > 8) throw new Error("Unbounded fixture page");
        pageStarts.push(start);
        return Response.json({
          entries: Array.from({ length: end - start }, (_, n) => {
            const seq = start + n;
            return encodeEntry({
              v: 3,
              seq,
              kind: "message",
              minimiser: "min-v1",
              payload: {
                native: JSON.stringify({
                  id: `msg_${seq}`,
                  type: "user",
                  time: { created: 1577836800000 + seq },
                  text:
                    seq === 27
                      ? "Exact shared target from teammate"
                      : `Pinned context ${seq}. `.repeat(30),
                }),
              },
            });
          }),
        });
      }
      throw new Error(`Unexpected fixture request ${pathname}`);
    },
  },
});
process.send?.({
  serverId: (await readFile(join(host.paseoHome, "server-id"), "utf8")).trim(),
  port: host.port,
});
process.on("message", async (message) => {
  if (conversation && typeof message === "object" && message !== null && "action" in message) {
    if (message.action === "deny") denied = true;
    if (message.action === "unavailable") unavailable = true;
    if (message.action === "allow") {
      denied = false;
      unavailable = false;
    }
    process.send?.({
      action: message.action,
      mutations,
      pageStarts,
      agents: host.daemon.agentManager.listAgents().length,
    });
    return;
  }
  releaseCatalog();
  await host.close();
  process.send?.({ mutations });
  process.disconnect?.();
});
