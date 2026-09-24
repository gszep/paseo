import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { OpenCodeV2AgentClient } from "./providers/opencode/v2/agent.js";
import { V2Harness } from "./providers/opencode/test-utils/v2-harness.js";
import { toAgentPayload } from "./agent-projections.js";

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, { purpose: "interactive" }]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("resuming a stored agent keeps its unread flag and its last-activity time", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-resume-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const manager = new AgentManager({
    clients: createTestAgentClients(),
    registry: storage,
    logger,
  });

  const agentId = "00000000-0000-4000-8000-000000000401";
  const lastActive = "2026-01-02T03:04:05.000Z";
  const markedUnread = "2026-01-09T03:04:05.000Z";

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-a",
    });
    await manager.closeAgent(agent.id);
    await manager.flush();
    await storage.flush();

    const stored = await storage.get(agentId);
    if (!stored) {
      throw new Error("expected a stored agent");
    }
    // The agent finished days ago, and was marked unread later without being opened, which
    // moves `updatedAt` on its own. Clients already hold that newer time, and
    // `acceptAgentDirectoryUpdate` drops anything older, so the resumed agent must not come
    // back carrying only `lastActivityAt`.
    await storage.upsert({
      ...stored,
      updatedAt: markedUnread,
      lastActivityAt: lastActive,
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: lastActive,
    });

    await ensureAgentLoaded(agentId, { agentManager: manager, agentStorage: storage, logger });
    await manager.flush();
    await storage.flush();

    // Loading the runtime is neither the agent working nor the user reading the chat.
    // Forging either rewrites the workspace's "last used" and drops it out of Ready to review.
    const resumed = await storage.get(agentId);
    expect(resumed?.requiresAttention).toBe(true);
    expect(resumed?.attentionReason).toBe("finished");
    expect(resumed?.updatedAt).toBe(markedUnread);
    expect(resumed?.lastActivityAt).toBe(markedUnread);
    expect(manager.getAgent(agentId)?.attention.requiresAttention).toBe(true);
    expect(manager.getAgent(agentId)?.updatedAt.toISOString()).toBe(markedUnread);
  } finally {
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["measured", "empty"] as const)(
  "OpenCode v2 idle resume and reload hydrate %s usage without changing recorded activity",
  async (history) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-loading-context-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const harness = new V2Harness();
    harness.models.push({
      id: "model",
      modelID: "model",
      providerID: "fixture",
      name: "Fixture",
      enabled: true,
      status: "active",
      time: { released: 0 },
      variants: [],
      cost: [],
      capabilities: { input: ["text"], output: ["text"], tools: true },
      limit: { context: 200_000, output: 8_000 },
    });
    if (history === "measured") {
      harness.history.push({
        id: "msg_context",
        type: "assistant",
        agent: "build",
        model: { providerID: "fixture", id: "model" },
        time: { created: 1, completed: 2 },
        content: [],
        tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 200, write: 30 } },
      });
    }
    const manager = new AgentManager({
      clients: { opencode: new OpenCodeV2AgentClient({ logger, runtime: harness.runtime }) },
      registry: storage,
      logger,
    });
    const id = "00000000-0000-4000-8000-000000000402";
    const updatedAt = "2026-01-09T03:04:05.000Z";
    const attentionTimestamp = "2026-01-02T03:04:05.000Z";
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      totalCostUsd: 0,
      ...(history === "measured"
        ? { contextWindowUsedTokens: 360, contextWindowMaxTokens: 200_000 }
        : {}),
    };
    try {
      await storage.upsert({
        id,
        provider: "opencode",
        cwd: root,
        workspaceId: "workspace-context",
        createdAt: attentionTimestamp,
        updatedAt,
        lastActivityAt: updatedAt,
        labels: {},
        lastStatus: "idle",
        persistence: { provider: "opencode", sessionId: harness.info.id, metadata: { cwd: root } },
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp,
      });
      await ensureAgentLoaded(id, { agentManager: manager, agentStorage: storage, logger });
      await manager.flush();
      await storage.flush();
      const resumed = manager.getAgent(id)!;
      expect(resumed.lastUsage).toEqual(usage);
      expect(resumed.updatedAt.toISOString()).toBe(updatedAt);
      expect(resumed.lifecycle).toBe("idle");
      expect(resumed.attention).toEqual({
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: new Date(attentionTimestamp),
      });
      expect(await storage.get(id)).toMatchObject({
        updatedAt,
        lastActivityAt: updatedAt,
        lastStatus: "idle",
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp,
      });
      expect(toAgentPayload(resumed).lastUsage).toEqual(usage);
      expect(toAgentPayload(resumed).runtimeInfo).not.toHaveProperty("usage");

      await manager.reloadAgentSession(id);
      await manager.flush();
      await storage.flush();
      const reloaded = manager.getAgent(id)!;
      expect(reloaded.lastUsage).toEqual(usage);
      expect(reloaded.updatedAt.toISOString()).toBe(updatedAt);
      expect(reloaded.lifecycle).toBe("idle");
      expect(reloaded.attention).toEqual(resumed.attention);
      expect(await storage.get(id)).toMatchObject({
        updatedAt,
        lastActivityAt: updatedAt,
        lastStatus: "idle",
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp,
      });
      expect(harness.prompts).toEqual([]);
    } finally {
      await manager.closeAgent(id).catch(() => undefined);
      await manager.flush();
      await storage.flush();
      await rm(root, { recursive: true, force: true });
    }
  },
);
