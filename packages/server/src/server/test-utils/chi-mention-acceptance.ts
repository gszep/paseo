import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DaemonClient } from "./daemon-client.js";
import { DEFAULT_BACKEND_URL } from "@henkaku-center/chi-native/repository";
import { append, endpointUrl } from "@henkaku-center/chi-native/http";
import type { NativeRuntime } from "@henkaku-center/chi-native/continuation";
import { createTestPaseoDaemon } from "./paseo-daemon.js";
import { createTestAgentClient } from "./fake-agent-client.js";
import { z } from "zod";
import { mentionFixtureTitle, purgeMentionFixtureSources } from "./chi-mention-fixture-sources.js";
import type { MutableChiConfig } from "@getpaseo/protocol/messages";

const repo = "github:gszep/chi-synthetic-two-actor-20260925";
interface NativeMessage {
  id: string;
  type: "user";
  text: string;
  metadata: { paseoClientMessageId: string };
  time: { created: number };
}

/** Whether a failed evidence POST is being simulated (the fixture's offline path). */
function isFailingEvidencePost(path: string, init?: RequestInit): boolean {
  return path.endsWith("/evidence") && init?.method === "POST";
}

/** Track the fixture's created sources and the audience each was stored with. */
async function recordEvidenceSource(
  response: Response,
  init: RequestInit | undefined,
  createdSources: Set<string>,
  sourceVisibility: Map<string, string>,
): Promise<void> {
  if (!response.ok) return;
  const body = await response.clone().json();
  if (typeof body.sourceId !== "string") return;
  createdSources.add(body.sourceId);
  try {
    const visibility = JSON.parse(String(init?.body))?.visibility;
    if (typeof visibility === "string") sourceVisibility.set(body.sourceId, visibility);
  } catch {
    // The request body is fixture-owned; a parse failure just skips the record.
  }
}

/** Live Chi identities and storage; a synthetic provider owns the native IDs and makes no model calls. */
export async function startMentionActor(
  actor: "sava-the-owl" | "mochi-the-kitty",
  origin: string,
  runId: string,
  fixtureOptions: { chi?: MutableChiConfig } = {},
) {
  if (process.env.CI) throw new Error("Live Chi acceptance refuses CI");
  const credentials = process.env.CHI_MENTION_TEST_ACTORS_DIR;
  if (!credentials)
    throw new Error("Set CHI_MENTION_TEST_ACTORS_DIR to the private test-account token directory");
  const token = (await readFile(join(credentials, `${actor}.chi-token`), "utf8")).trim();
  // The live repository catalog can be cold after deployment. Establish its
  // readiness before the rendered scenario; real capture still reauthorizes it.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(append(endpointUrl(DEFAULT_BACKEND_URL), "repos"), {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${token}` },
    });
    await response.body?.cancel();
    if (response.ok) break;
    if (response.status !== 503 || attempt === 2)
      throw new Error(`Synthetic repository readiness failed: ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  async function removeSource(sourceId: string) {
    const url = append(endpointUrl(DEFAULT_BACKEND_URL), "evidence");
    url.searchParams.set("sourceId", sourceId);
    const response = await fetch(url, {
      method: "DELETE",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "x-chi-repo": repo },
    });
    if (!response.ok) throw new Error(`Synthetic source purge failed: ${response.status}`);
    await response.body?.cancel();
  }
  await purgeMentionFixtureSources({
    actor,
    remove: removeSource,
    list: async (cursor) => {
      const url = append(endpointUrl(DEFAULT_BACKEND_URL), "evidence");
      url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url, {
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "x-chi-repo": repo },
      });
      if (!response.ok) throw new Error(`Synthetic source listing failed: ${response.status}`);
      return response.json();
    },
  });
  const cwd = await mkdtemp(join(tmpdir(), "paseo-mention-project-"));
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", [
    "-C",
    cwd,
    "remote",
    "add",
    "origin",
    "https://github.com/gszep/chi-synthetic-two-actor-20260925.git",
  ]);
  await writeFile(join(cwd, "mention-file.txt"), "Synthetic file autocomplete fixture\n");
  execFileSync("git", ["-C", cwd, "add", "mention-file.txt"]);
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Synthetic test",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-qm",
    "Initialize synthetic workspace",
  ]);
  const messages = new Map<string, NativeMessage[]>();
  const runtime: NativeRuntime = {
    identity: `synthetic:${actor}`,
    info: async () => ({ version: "synthetic" }),
    schema: async () => ({}),
    get: async () => null,
    export: async (sessionId) => ({
      info: {
        id: sessionId,
        title: `${mentionFixtureTitle} ${runId}`,
        location: { directory: cwd },
      },
      messages: messages.get(sessionId) ?? [],
    }),
    import: async () => {
      throw new Error("No native mutation in mention acceptance");
    },
    fork: async () => {
      throw new Error("No native mutation in mention acceptance");
    },
  };
  let loseCreateReply = false,
    loseReplyReply = false,
    failEvidence = false;
  const createdSources = new Set<string>();
  const sourceVisibility = new Map<string, string>();
  const createAttempts: string[] = [];
  const replyAttempts: string[] = [];
  const authority = {
    endpoint: DEFAULT_BACKEND_URL,
    login: async () => ({
      schemaVersion: 1 as const,
      identityProvider: "github",
      repoProvider: "github",
      createdAt: new Date().toISOString(),
      sessionToken: token,
      chiUserId: `github:${actor}`,
    }),
    invalidate: () => undefined,
    request: (async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (failEvidence && isFailingEvidencePost(path, init))
        throw new Error("Synthetic evidence failure");
      const response = await fetch(url, init);
      if (path.endsWith("/evidence") && init?.method === "POST")
        await recordEvidenceSource(response, init, createdSources, sourceVisibility);
      if (path.endsWith("/handoffs") && init?.method === "POST") {
        createAttempts.push(String(init.body));
        if (loseCreateReply && response.ok) {
          loseCreateReply = false;
          await response.body?.cancel();
          throw new Error("Synthetic lost reply after actual durable handoff creation");
        }
      }
      if (path.endsWith("/handoffs/reply") && init?.method === "POST") {
        replyAttempts.push(String(init.body));
        if (loseReplyReply && response.ok) {
          loseReplyReply = false;
          await response.body?.cancel();
          throw new Error("Synthetic lost reply after actual durable response creation");
        }
      }
      return response;
    }) satisfies typeof fetch,
  };
  const agentClient = createTestAgentClient("opencode", {
    nativeRuntime: runtime,
    humanPromptTurnId: async (sessionId) => messages.get(sessionId)?.at(-1)?.id ?? null,
    questionForPrompt: (prompt) =>
      prompt.startsWith("Ask an inbox question")
        ? {
            questions: [
              {
                header: "Choice",
                question: `Synthetic human prompt ${runId}: choose a colour`,
                options: [
                  { label: "Blue", description: "Use blue" },
                  { label: "Green", description: "Use green" },
                ],
              },
            ],
          }
        : null,
    onStartTurn(prompt, options, sessionId) {
      if (!options?.clientMessageId || typeof prompt !== "string")
        throw new Error("Synthetic fixture requires a correlated text prompt");
      const previous = messages.get(sessionId) ?? [];
      const id = `msg_synthetic_${randomUUID()}`;
      previous.push({
        id,
        type: "user",
        text: prompt,
        metadata: { paseoClientMessageId: options.clientMessageId },
        time: { created: Date.now() },
      });
      messages.set(sessionId, previous);
      return {
        type: "user_message",
        text: prompt,
        messageId: id,
        clientMessageId: options.clientMessageId,
      };
    },
  });
  process.env.PASEO_SUPERVISED = "0";
  const paseoHomeRoot = await mkdtemp(join(tmpdir(), "paseo-mention-home-"));
  const createHost = () =>
    createTestPaseoDaemon({
      chiAuthority: authority,
      agentClients: { opencode: agentClient },
      corsAllowedOrigins: [origin],
      mcpEnabled: false,
      chi: fixtureOptions.chi,
      paseoHomeRoot,
      cleanup: false,
    });
  let host = await createHost();
  const connectClient = async () => {
    const next = new DaemonClient({
      url: `ws://127.0.0.1:${host.port}/ws`,
      appVersion: "0.9.0-beta.2",
    });
    await next.connect();
    await next.fetchAgents();
    return next;
  };
  let client = await connectClient();
  const serverId = client.getLastServerInfoMessage()?.serverId;
  if (!serverId) throw new Error("Missing isolated host identity");
  const project = await client.addProject(cwd);
  if (!project.project) throw new Error("Synthetic project creation failed");
  const created = await client.createWorkspace({
    source: { kind: "directory", path: cwd, projectId: project.project.projectId },
  });
  const workspace = created.workspace;
  if (!workspace) throw new Error("Synthetic workspace missing");
  const agent = await client.createAgent({
    provider: "opencode",
    cwd,
    workspaceId: workspace.id,
    title: `Mention acceptance ${actor} ${runId}`,
    modeId: "default",
  });
  const localCwd = await mkdtemp(join(tmpdir(), "paseo-local-mention-"));
  await writeFile(join(localCwd, "local-file.txt"), "Local file completion fixture\n");
  const localProject = await client.addProject(localCwd);
  if (!localProject.project) throw new Error("Local project creation failed");
  const localWorkspace = (
    await client.createWorkspace({
      source: { kind: "directory", path: localCwd, projectId: localProject.project.projectId },
    })
  ).workspace;
  if (!localWorkspace) throw new Error("Local workspace missing");
  const localAgent = await client.createAgent({
    provider: "opencode",
    cwd: localCwd,
    workspaceId: localWorkspace.id,
    title: "Local workspace without a repository",
    modeId: "default",
  });
  async function sourceRequest(path: string, method: string, body?: unknown) {
    const response = await fetch(append(endpointUrl(DEFAULT_BACKEND_URL), path), {
      method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        "x-chi-repo": repo,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(`Synthetic fixture cleanup/access mutation failed: ${response.status}`);
  }
  return {
    localAgentId: localAgent.id,
    localWorkspaceId: localWorkspace.id,
    workspaceId: workspace.id,
    agentId: agent.id,
    serverId,
    get port() {
      return host.port;
    },
    createAttempts,
    replyAttempts,
    loseNextCreateReply() {
      loseCreateReply = true;
    },
    loseNextReplyReply() {
      loseReplyReply = true;
    },
    setFailEvidence(value: boolean) {
      failEvidence = value;
    },
    /** Seed a pre-P1 association label: no destination, endpoint or audience. */
    async seedLegacyAssociation() {
      await client.updateAgent(agent.id, {
        labels: {
          "chi.native": JSON.stringify({
            repo,
            actor: `github:${actor}`,
            sourceId: null,
            head: null,
            error: null,
          }),
        },
      });
    },
    sources() {
      return [...createdSources];
    },
    sourceVisibilities() {
      return Object.fromEntries(sourceVisibility);
    },
    sourceVisibility(sourceId: string) {
      return sourceVisibility.get(sourceId) ?? null;
    },
    /** Recreate the daemon on the same persisted home, then reconnect the fixture client. */
    async restart() {
      await client.close().catch(() => undefined);
      await host.close().catch(() => undefined);
      host = await createHost();
      client = await connectClient();
      return { port: host.port };
    },
    async hideSources() {
      for (const sourceId of createdSources)
        await sourceRequest("evidence/visibility", "PATCH", { sourceId, visibility: "private" });
    },
    async close() {
      try {
        // The rendered continuation can finish before its settled capture. Drain
        // that writer and stop the isolated host before purging its evidence.
        await host.daemon.agentManager.chi?.capture(agent.id).catch(() => undefined);
        await client.removeProject(project.project!.projectId).catch(() => undefined);
        await client.removeProject(localProject.project!.projectId).catch(() => undefined);
        await client.close().catch(() => undefined);
        await host.close();
        for (const sourceId of createdSources) await removeSource(sourceId);
      } finally {
        await rm(cwd, { recursive: true, force: true });
        await rm(localCwd, { recursive: true, force: true });
        await rm(paseoHomeRoot, { recursive: true, force: true });
      }
    },
  };
}

const actor = z.enum(["sava-the-owl", "mochi-the-kitty"]).parse(process.argv[2]);
const origin = z.string().url().parse(process.argv[3]);
const runId = z.string().uuid().parse(process.argv[4]);
const chiConfigJson = process.argv[5];
const chiConfig = chiConfigJson
  ? z
      .object({
        destinations: z.record(
          z.string(),
          z.object({ name: z.string(), endpoint: z.string() }).strict(),
        ),
        mappings: z.array(
          z
            .object({
              repo: z.string(),
              destination: z.string(),
              audience: z.enum(["private", "shared"]).optional(),
            })
            .strict(),
        ),
      })
      .strict()
      .parse(JSON.parse(chiConfigJson))
  : undefined;
const instance = await startMentionActor(actor, origin, runId, { chi: chiConfig });
// Surface a mid-run crash with its stack/exit signal; the parent only logs the
// diagnostics buffer on startup failure otherwise.
process.on("uncaughtException", (error) => {
  console.error("[chi-mention-acceptance] uncaughtException", error);
  process.exit(70);
});
process.on("unhandledRejection", (reason) => {
  console.error("[chi-mention-acceptance] unhandledRejection", reason);
  process.exit(70);
});
process.on("exit", (code) => {
  console.error(`[chi-mention-acceptance] exit code=${code}`);
});
process.send?.({
  type: "ready",
  serverId: instance.serverId,
  workspaceId: instance.workspaceId,
  agentId: instance.agentId,
  localAgentId: instance.localAgentId,
  localWorkspaceId: instance.localWorkspaceId,
  port: instance.port,
});
process.on("message", async (value) => {
  const request = z
    .object({
      id: z.string(),
      action: z.enum([
        "lose-create",
        "lose-reply",
        "hide",
        "attempts",
        "close",
        "fail-evidence",
        "allow-evidence",
        "restart",
        "seed-legacy",
        "sources",
      ]),
    })
    .parse(value);
  try {
    if (request.action === "lose-create") instance.loseNextCreateReply();
    if (request.action === "lose-reply") instance.loseNextReplyReply();
    if (request.action === "fail-evidence") instance.setFailEvidence(true);
    if (request.action === "allow-evidence") instance.setFailEvidence(false);
    if (request.action === "seed-legacy") await instance.seedLegacyAssociation();
    if (request.action === "hide") await instance.hideSources();
    if (request.action === "restart") await instance.restart();
    if (request.action === "close") await instance.close();
    process.send?.({
      id: request.id,
      ok: true,
      createAttempts: instance.createAttempts,
      replyAttempts: instance.replyAttempts,
      port: instance.port,
      sources: instance.sources(),
      sourceVisibilities: instance.sourceVisibilities(),
    });
    if (request.action === "close") process.disconnect();
  } catch (error) {
    process.send?.({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "fixture-operation-failed",
    });
  }
});
