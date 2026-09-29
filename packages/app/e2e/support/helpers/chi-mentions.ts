import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Page } from "@playwright/test";
import { buildSeededHost } from "./daemon-registry";
import { spawnTsx, killProcessTree } from "./spawn-node";

const readySchema = z.object({
  type: z.literal("ready"),
  serverId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  localAgentId: z.string(),
  localWorkspaceId: z.string(),
  port: z.number(),
});
const responseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    id: z.string(),
    createAttempts: z.array(z.string()),
    replyAttempts: z.array(z.string()),
    port: z.number(),
    sources: z.array(z.string()).optional(),
  }),
  z.object({ ok: z.literal(false), id: z.string(), error: z.string() }),
]);
type Action =
  | "lose-create"
  | "lose-reply"
  | "hide"
  | "attempts"
  | "close"
  | "fail-evidence"
  | "allow-evidence"
  | "restart"
  | "seed-legacy"
  | "sources";
interface MentionActorOptions {
  chi?: unknown;
}

export async function startMentionActor(
  actor: "sava-the-owl" | "mochi-the-kitty",
  origin: string,
  runId: string,
  options: MentionActorOptions = {},
) {
  const root = path.resolve(__dirname, "../../../../..");
  const args = [actor, origin, runId];
  if (options.chi) args.push(JSON.stringify(options.chi));
  const child = spawnTsx(
    path.join(root, "packages/server/src/server/test-utils/chi-mention-acceptance.ts"),
    args,
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
  const ready = await new Promise<z.infer<typeof readySchema>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Mention fixture startup timed out: ${diagnostics}`)),
      45000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Mention fixture exited ${code}: ${diagnostics}`));
    });
    child.once("message", (value) => {
      clearTimeout(timer);
      resolve(readySchema.parse(value));
    });
  }).catch(async (error) => {
    await killProcessTree(child);
    throw error;
  });
  let port = ready.port;
  function request(action: Action) {
    const id = randomUUID();
    return new Promise<Extract<z.infer<typeof responseSchema>, { ok: true }>>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("message", onMessage);
        reject(new Error(`Mention fixture ${action} timed out`));
      }, 45000);
      function onMessage(value: unknown) {
        const parsed = responseSchema.safeParse(value);
        if (!parsed.success || parsed.data.id !== id) return;
        clearTimeout(timer);
        child.off("message", onMessage);
        if (!parsed.data.ok) reject(new Error(parsed.data.error));
        else resolve(parsed.data);
      }
      child.on("message", onMessage);
      child.send({ action, id });
    });
  }
  return {
    ...ready,
    get port() {
      return port;
    },
    loseNextCreateReply: () => request("lose-create"),
    loseNextReplyReply: () => request("lose-reply"),
    hideSources: () => request("hide"),
    attempts: () => request("attempts"),
    failEvidence: () => request("fail-evidence"),
    allowEvidence: () => request("allow-evidence"),
    seedLegacyAssociation: () => request("seed-legacy"),
    async sources() {
      return (await request("sources")).sources ?? [];
    },
    /** Recreate the daemon on the same persisted home; returns the new port. */
    async restart() {
      const result = await request("restart");
      port = result.port;
      return result.port;
    },
    async seed(page: Page) {
      const host = buildSeededHost({
        serverId: ready.serverId,
        endpoint: `127.0.0.1:${port}`,
        label: actor,
        nowIso: new Date().toISOString(),
      });
      await page.addInitScript((savedHost) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify([savedHost]));
        localStorage.removeItem("@paseo:settings");
      }, host);
    },
    async close() {
      try {
        await request("close");
      } finally {
        await killProcessTree(child);
      }
    },
  };
}
