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
  port: z.number(),
});
const responseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    id: z.string(),
    createAttempts: z.array(z.string()),
    replyAttempts: z.array(z.string()),
  }),
  z.object({ ok: z.literal(false), id: z.string(), error: z.string() }),
]);
type Action = "lose-create" | "lose-reply" | "hide" | "attempts" | "close";

export async function startMentionActor(
  actor: "sava-the-owl" | "mochi-the-kitty",
  origin: string,
  runId: string,
) {
  const root = path.resolve(__dirname, "../../../../..");
  const child = spawnTsx(
    path.join(root, "packages/server/src/server/test-utils/chi-mention-acceptance.ts"),
    [actor, origin, runId],
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
    loseNextCreateReply: () => request("lose-create"),
    loseNextReplyReply: () => request("lose-reply"),
    hideSources: () => request("hide"),
    attempts: () => request("attempts"),
    async seed(page: Page) {
      const host = buildSeededHost({
        serverId: ready.serverId,
        endpoint: `127.0.0.1:${ready.port}`,
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
