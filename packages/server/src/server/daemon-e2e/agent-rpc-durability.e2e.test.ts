import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import type { AgentAttachment } from "@getpaseo/protocol/messages";

import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const CREATED_AT = "2026-06-29T11:12:42.000Z";
const HEALTHY_UPDATED_AT = "2026-06-29T11:40:00.000Z";
const ORPHAN_ARCHIVED_AT = "2026-06-29T11:35:35.000Z";

test.skipIf(process.platform === "win32")(
  "mention intent is created only inside admitted message receipts, and transformed sends reject before admission",
  async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "mention-admission-"));
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", [
      "-C",
      cwd,
      "remote",
      "add",
      "origin",
      "https://github.com/fixture/repo.git",
    ]);
    const repo = "github:fixture/repo",
      actor = "github:sender";
    const submitted: string[] = [];
    const backendWrites: string[] = [];
    let credentialGeneration = "original",
      loggedOut = false;
    const host = await createTestPaseoDaemon({
      mcpEnabled: false,
      chi: {
        destinations: { fixture: { name: "Fixture", endpoint: "https://chi.invalid" } },
        mappings: [{ repo, destination: "fixture", audience: "shared" }],
      },
      agentClients: {
        opencode: createTestAgentClient("opencode", {
          onStartTurn(_prompt, options) {
            submitted.push(options!.clientMessageId!);
          },
        }),
      },
      chiAuthority: {
        invalidate: () => undefined,
        endpoint: "https://chi.invalid",
        login: async () => {
          if (loggedOut) throw new Error("chi-github-login-required");
          return { sessionToken: "fixture", chiUserId: actor, credentialGeneration };
        },
        request: async (url, init) => {
          const target = new URL(String(url));
          if (init?.method && init.method !== "GET") backendWrites.push(target.pathname);
          if (target.pathname === "/auth/session")
            return Response.json({
              ok: true,
              chiUserId: actor,
              capabilities: {
                appendLog: { v: 3, deployment: "fixture" },
                handoffs: { v: 3, references: "pin-seq" },
              },
            });
          if (target.pathname === "/repos") return Response.json({ ok: true, repos: [{ repo }] });
          if (target.pathname === "/participants")
            return Response.json({
              ok: true,
              self: actor,
              participants: [{ ownerId: "github:recipient", handle: "recipient" }],
            });
          return new Response(null, { status: 503 });
        },
      },
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${host.port}/ws` });
    let projectId: string | undefined;
    try {
      await client.connect();
      await client.fetchAgents();
      const project = await client.addProject(cwd);
      projectId = project.project!.projectId;
      const workspace = (
        await client.createWorkspace({ source: { kind: "directory", path: cwd, projectId } })
      ).workspace!;
      const agent = await client.createAgent({
        provider: "opencode",
        cwd,
        workspaceId: workspace.id,
        labels: {
          "chi.native": JSON.stringify({
            repo,
            actor,
            sourceId: null,
            head: null,
            error: null,
            endpoint: "https://chi.invalid",
            destination: "fixture",
          }),
        },
      });
      const scope = await client.chiMentions({
        workspaceId: workspace.id,
        operation: { action: "scope" },
      });
      const text = "@recipient please check";
      await client.sendAgentMessage(agent.id, text, { messageId: "ordinary-first" });
      await client.waitForFinish(agent.id);
      await expect(
        client.sendAgentMessage(agent.id, text, {
          messageId: "ordinary-first",
          chiMentions: ["github:recipient"],
          chiMentionContext: scope.context,
        }),
      ).rejects.toThrow("agent_request_key_conflict");
      const owner = host.daemon.agentManager.chi!;
      await owner.mentions.captured({
        agentId: agent.id,
        identity: { repo, actor, token: "fixture", deployment: "fixture" },
        pin: {
          v: 3,
          deployment: "fixture",
          repo,
          sourceId: "a".repeat(64),
          count: 1,
          head: "b".repeat(64),
        },
        messages: [
          {
            id: "native-exact",
            seq: 0,
            payload: { type: "user", text, metadata: { paseoClientMessageId: "ordinary-first" } },
          },
        ],
      });
      expect(
        await client.chiMentions({
          workspaceId: workspace.id,
          expectedContext: scope.context,
          operation: { action: "delivery", agentId: agent.id },
        }),
      ).toMatchObject({ kind: "delivery", deliveries: [] });
      const transformed: Array<{
        text: string;
        attachments?: AgentAttachment[];
        images?: Array<{ data: string; mimeType: string }>;
      }> = [
        { text: "/review @recipient" },
        { text: "/skill @recipient" },
        { text, attachments: [{ type: "text", mimeType: "text/plain", text: "expanded context" }] },
        { text, images: [{ data: "aGVsbG8=", mimeType: "image/png" }] },
      ];
      for (const [i, input] of transformed.entries()) {
        const messageId = `rejected-transform-${i}`;
        await expect(
          client.sendAgentMessage(agent.id, input.text, {
            ...input,
            messageId,
            chiMentions: ["github:recipient"],
            chiMentionContext: scope.context,
          }),
        ).rejects.toThrow("chi-mention-plain-text-required");
        // The rejected request did not reserve the ID. A plain send can still use it.
        await client.sendAgentMessage(agent.id, "plain replacement", { messageId });
        await client.waitForFinish(agent.id);
      }
      expect(submitted).toEqual([
        "ordinary-first",
        ...transformed.map((_, i) => `rejected-transform-${i}`),
      ]);
      expect(backendWrites).toEqual([]);
      await expect(
        client.sendAgentMessage(agent.id, "x".repeat(8001), {
          messageId: "oversized",
          chiMentions: ["github:recipient"],
          chiMentionContext: scope.context,
        }),
      ).rejects.toMatchObject({ failure: { outcome: "not_committed" } });
      await expect(
        client.sendAgentMessage(agent.id, "@missing check", {
          messageId: "unavailable",
          chiMentions: ["github:missing"],
          chiMentionContext: scope.context,
        }),
      ).rejects.toMatchObject({
        message: "chi-mention-recipient-unavailable",
        failure: { outcome: "not_committed" },
      });
      await client.sendAgentMessage(agent.id, "ordinary after rejection", {
        messageId: "ordinary-after-rejection",
      });
      await client.waitForFinish(agent.id);
      const saved = {
        messageId: "rotate-credentials",
        chiMentions: ["github:recipient"],
        chiMentionContext: scope.context,
      };
      credentialGeneration = "rotated";
      await expect(client.sendAgentMessage(agent.id, text, saved)).rejects.toMatchObject({
        message: "chi-mention-context-changed",
        failure: { outcome: "not_committed" },
      });
      const fresh = await client.chiMentions({
        workspaceId: workspace.id,
        operation: { action: "scope" },
      });
      const authorized = { ...saved, chiMentionAuthorization: fresh.context };
      await client.sendAgentMessage(agent.id, text, authorized);
      await client.waitForFinish(agent.id);
      await client.sendAgentMessage(agent.id, text, authorized);
      expect(submitted.filter((id) => id === saved.messageId)).toHaveLength(1);
      await expect(
        client.sendAgentMessage(agent.id, text, {
          ...authorized,
          chiMentionAuthorization: { ...fresh.context, actor: "github:other" },
        }),
      ).rejects.toMatchObject({ message: "chi-mention-context-changed" });
      loggedOut = true;
      await expect(
        client.chiMentions({
          workspaceId: workspace.id,
          expectedContext: fresh.context,
          operation: { action: "retry", agentId: agent.id },
        }),
      ).rejects.toMatchObject({
        message: "chi-github-login-required",
        failure: { accessLost: true, outcome: "unknown" },
      });
    } finally {
      if (projectId) await client.removeProject(projectId);
      await client.close();
      await host.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

interface StaleAgentFixture {
  healthyProjectId: string;
  healthyWorkspaceId: string;
  orphanWorkspaceId: string;
  healthyAgentId: string;
  orphanAgentId: string;
  paseoHomeRoot: string;
  cleanupPaths: string[];
}

test("agent fetch RPCs tolerate an agent whose workspace project record is gone", async () => {
  const fixture = seedStaleAgentFixture();
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;

  try {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: fixture.paseoHomeRoot,
      cleanup: false,
      agentClients: { codex: createTestAgentClient("codex") },
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();

    const agents = await client.fetchAgents({
      requestId: "req-agent-rpc-list",
      filter: { includeArchived: true },
    });
    const history = await client.fetchAgentHistory({
      requestId: "req-agent-rpc-history",
    });
    const orphanAgent = await client.fetchAgent({
      requestId: "req-agent-rpc-detail",
      agentId: fixture.orphanAgentId,
    });

    expect(agents.entries.map(toAgentEntrySummary)).toEqual([healthyAgentSummary(fixture)]);
    expect(agents.pageInfo).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
    expect(history.entries.map(toAgentEntrySummary)).toEqual([healthyAgentSummary(fixture)]);
    expect(history.pageInfo).toEqual({
      nextCursor: null,
      prevCursor: null,
      hasMore: false,
    });
    expect({
      agentId: orphanAgent?.agent.id,
      workspaceId: orphanAgent?.agent.workspaceId,
      archivedAt: orphanAgent?.agent.archivedAt,
      project: orphanAgent?.project,
    }).toEqual({
      agentId: fixture.orphanAgentId,
      workspaceId: fixture.orphanWorkspaceId,
      archivedAt: ORPHAN_ARCHIVED_AT,
      project: null,
    });
  } finally {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    for (const target of fixture.cleanupPaths) {
      // Match createTestPaseoDaemon's cleanup: Windows can retain filesystem
      // handles briefly after daemon shutdown. Retry only transient OS errors.
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
});

test("history search filters before pagination and keeps newest matches first", async () => {
  const fixture = seedStaleAgentFixture();
  let daemon: TestPaseoDaemon | null = null;
  let client: DaemonClient | null = null;
  try {
    const agentsDir = path.join(fixture.paseoHomeRoot, ".paseo", "agents");
    const template = JSON.parse(
      readFileSync(path.join(agentsDir, `${fixture.healthyAgentId}.json`), "utf8"),
    );
    for (const [id, title, updatedAt] of [
      ["newer-partial", "Unbilled usage", "2026-06-29T13:00:00.000Z"],
      ["unrelated", "Terminal resizing", "2026-06-29T12:00:00.000Z"],
      ["older-exact", "bill", "2026-06-28T12:00:00.000Z"],
    ]) {
      writeJson(path.join(agentsDir, `${id}.json`), {
        ...template,
        id,
        title,
        updatedAt,
        lastActivityAt: updatedAt,
      });
    }
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: fixture.paseoHomeRoot,
      cleanup: false,
      agentClients: { codex: createTestAgentClient("codex") },
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    const first = await client.fetchAgentHistory({ search: "bill", page: { limit: 1 } });
    expect(first.entries.map((entry) => entry.agent.id)).toEqual(["newer-partial"]);
    expect(first.pageInfo.hasMore).toBe(true);
    expect(first.pageInfo.nextCursor).toBeTypeOf("string");
    const second = await client.fetchAgentHistory({
      search: "bill",
      page: { limit: 1, cursor: first.pageInfo.nextCursor! },
    });
    expect(second.entries.map((entry) => entry.agent.id)).toEqual(["older-exact"]);
    expect(second.pageInfo.hasMore).toBe(false);
    expect(second.entries[0].searchMatches).toBeUndefined();
  } finally {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    for (const target of fixture.cleanupPaths)
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

function seedStaleAgentFixture(): StaleAgentFixture {
  const healthyCwd = mkdtempSync(path.join(os.tmpdir(), "paseo-healthy-agent-"));
  const orphanCwd = mkdtempSync(path.join(os.tmpdir(), "paseo-orphan-agent-"));
  const paseoHomeRoot = mkdtempSync(path.join(os.tmpdir(), "paseo-orphan-agent-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const projectsDir = path.join(paseoHome, "projects");
  const agentsDir = path.join(paseoHome, "agents");
  const healthyProjectId = "proj-healthy-agent-rpc";
  const healthyWorkspaceId = "ws-healthy-agent-rpc";
  const orphanWorkspaceId = "c:\\Users\\paseo\\stale-project";
  const orphanProjectId = "proj-removed-agent-rpc";
  const healthyAgentId = "agent-healthy-rpc";
  const orphanAgentId = "agent-orphan-rpc";

  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  writeJson(path.join(projectsDir, "projects.json"), [
    {
      projectId: healthyProjectId,
      rootPath: healthyCwd,
      kind: "non_git",
      displayName: "healthy",
      customName: null,
      createdAt: CREATED_AT,
      updatedAt: HEALTHY_UPDATED_AT,
      archivedAt: null,
    },
  ]);
  writeJson(path.join(projectsDir, "workspaces.json"), [
    {
      workspaceId: healthyWorkspaceId,
      projectId: healthyProjectId,
      cwd: healthyCwd,
      kind: "directory",
      displayName: "healthy",
      title: null,
      branch: null,
      baseBranch: null,
      createdAt: CREATED_AT,
      updatedAt: HEALTHY_UPDATED_AT,
      archivedAt: null,
    },
    {
      workspaceId: orphanWorkspaceId,
      projectId: orphanProjectId,
      cwd: orphanCwd,
      kind: "directory",
      displayName: "stale project",
      title: null,
      branch: null,
      baseBranch: null,
      createdAt: CREATED_AT,
      updatedAt: ORPHAN_ARCHIVED_AT,
      archivedAt: ORPHAN_ARCHIVED_AT,
    },
  ]);
  writeJson(path.join(agentsDir, `${healthyAgentId}.json`), {
    id: healthyAgentId,
    provider: "codex",
    cwd: healthyCwd,
    workspaceId: healthyWorkspaceId,
    createdAt: CREATED_AT,
    updatedAt: HEALTHY_UPDATED_AT,
    lastActivityAt: HEALTHY_UPDATED_AT,
    lastUserMessageAt: null,
    title: "Healthy Agent",
    labels: {},
    lastStatus: "idle",
    lastModeId: "full-access",
    config: null,
    persistence: null,
  });
  writeJson(path.join(agentsDir, `${orphanAgentId}.json`), {
    id: orphanAgentId,
    provider: "codex",
    cwd: orphanCwd,
    workspaceId: orphanWorkspaceId,
    createdAt: CREATED_AT,
    updatedAt: ORPHAN_ARCHIVED_AT,
    lastActivityAt: ORPHAN_ARCHIVED_AT,
    lastUserMessageAt: null,
    title: "Orphaned Archived Agent",
    labels: {},
    lastStatus: "closed",
    lastModeId: "full-access",
    config: null,
    persistence: null,
    archivedAt: ORPHAN_ARCHIVED_AT,
  });

  return {
    healthyProjectId,
    healthyWorkspaceId,
    orphanWorkspaceId,
    healthyAgentId,
    orphanAgentId,
    paseoHomeRoot,
    cleanupPaths: [healthyCwd, orphanCwd, paseoHomeRoot],
  };
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface AgentDirectoryEntrySummaryInput {
  agent: {
    id: string;
    workspaceId?: string;
    archivedAt?: string | null;
  };
  project: {
    projectKey: string;
    projectName: string;
    workspaceName?: string | null;
  };
}

function healthyAgentSummary(fixture: StaleAgentFixture) {
  return {
    agentId: fixture.healthyAgentId,
    workspaceId: fixture.healthyWorkspaceId,
    archivedAt: null,
    projectKey: fixture.healthyProjectId,
    projectName: "healthy",
    workspaceName: "healthy",
  };
}

function toAgentEntrySummary(entry: AgentDirectoryEntrySummaryInput) {
  return {
    agentId: entry.agent.id,
    workspaceId: entry.agent.workspaceId,
    archivedAt: entry.agent.archivedAt ?? null,
    projectKey: entry.project.projectKey,
    projectName: entry.project.projectName,
    workspaceName: entry.project.workspaceName ?? null,
  };
}
