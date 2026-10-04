import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ISOLATION_REASON_LABEL,
  ISOLATION_WORKTREE_LABEL,
  PARENT_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";

import { DaemonClient } from "./test-utils/index.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const PROVIDER = "codex";
const MODEL = "gpt-5.4-mini";
const MODE = "full-access";

interface ToolCallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

let daemon: TestPaseoDaemon;
let client: DaemonClient;
let tempRoot: string;
const logLines: string[] = [];
const mcpClients: Client[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

// main has one commit; the checked-out feature branch adds another, so a worktree
// based on the caller's branch differs from one based on the default branch.
function createRepo(name: string): string {
  const repoDir = path.join(tempRoot, name);
  execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
  git(repoDir, ["config", "user.email", "test@getpaseo.local"]);
  git(repoDir, ["config", "user.name", "Paseo Test"]);
  git(repoDir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "initial"]);
  git(repoDir, ["checkout", "-b", "feature/base"]);
  writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");
  git(repoDir, ["add", "feature.txt"]);
  git(repoDir, ["commit", "-m", "feature work"]);
  return realpathSync(repoDir);
}

function createPlainDirectory(name: string): string {
  const dir = path.join(tempRoot, name);
  execFileSync("mkdir", ["-p", dir]);
  return realpathSync(dir);
}

function worktreePaths(repoDir: string): string[] {
  return git(repoDir, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => realpathSync(line.slice("worktree ".length)));
}

async function activeWorkspaceIds(): Promise<string[]> {
  const workspaces = await client.fetchWorkspaces();
  return workspaces.entries.map((entry) => entry.id).sort();
}

async function createHumanAgent(cwd: string, title: string) {
  const workspace = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
  if (!workspace.workspace) throw new Error(workspace.error ?? "workspace create failed");
  return client.createAgent({
    provider: PROVIDER,
    model: MODEL,
    modeId: MODE,
    cwd,
    workspaceId: workspace.workspace.id,
    title,
  });
}

async function mcpClientFor(callerAgentId?: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${daemon.port}/mcp/agents`);
  if (callerAgentId) url.searchParams.set("callerAgentId", callerAgentId);
  const mcp = new Client({ name: "subagent-isolation-test", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(url));
  mcpClients.push(mcp);
  return mcp;
}

async function callTool(mcp: Client, args: Record<string, unknown>): Promise<ToolCallResult> {
  return (await mcp.callTool({ name: "create_agent", arguments: args })) as ToolCallResult;
}

async function createSubagent(mcp: Client, args: Record<string, unknown> = {}) {
  const result = await callTool(mcp, {
    title: "Subagent",
    provider: `${PROVIDER}/${MODEL}`,
    initialPrompt: "Say done.",
    settings: { modeId: MODE },
    ...args,
  });
  if (result.isError) {
    throw new Error(result.content?.[0]?.text ?? "create_agent failed");
  }
  const content = result.structuredContent ?? {};
  const agentId = String(content.agentId);
  const record = await daemon.daemon.agentStorage.get(agentId);
  if (!record) throw new Error(`created agent ${agentId} is not stored`);
  return { content, record };
}

async function expectToolError(mcp: Client, args: Record<string, unknown>, pattern: RegExp) {
  const result = await callTool(mcp, {
    title: "Subagent",
    provider: `${PROVIDER}/${MODEL}`,
    initialPrompt: "Say done.",
    settings: { modeId: MODE },
    ...args,
  });
  expect(result.isError).toBe(true);
  expect(result.content?.[0]?.text ?? "").toMatch(pattern);
}

function isolationLogEntries(): Array<Record<string, unknown>> {
  return logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === "subagent_isolation");
}

beforeAll(async () => {
  tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "subagent-isolation-")));
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) logLines.push(line);
      }
      callback();
    },
  });
  daemon = await createTestPaseoDaemon({ logger: pino({ level: "info" }, logStream) });
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
}, 60_000);

afterAll(async () => {
  for (const mcp of mcpClients) await mcp.close().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await daemon?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("agent-scoped create_agent worktree isolation", () => {
  test("human-created agents keep their checkout and get no isolation record", async () => {
    const repoDir = createRepo("human-repo");
    const before = worktreePaths(repoDir);

    const human = await createHumanAgent(repoDir, "Human agent");
    expect(realpathSync(human.cwd)).toBe(repoDir);
    expect(Object.keys(human.labels).filter((key) => key.startsWith("paseo.isolation."))).toEqual(
      [],
    );

    const topLevel = await mcpClientFor();
    const result = await callTool(topLevel, {
      title: "Top-level MCP agent",
      provider: `${PROVIDER}/${MODEL}`,
      initialPrompt: "Say done.",
      settings: { modeId: MODE },
      workspaceId: human.workspaceId,
      background: true,
    });
    expect(result.isError).toBeFalsy();
    const topLevelRecord = await daemon.daemon.agentStorage.get(
      String(result.structuredContent?.agentId),
    );
    expect(realpathSync(topLevelRecord?.cwd ?? "")).toBe(repoDir);
    expect(topLevelRecord?.labels[ISOLATION_WORKTREE_LABEL]).toBeUndefined();
    expect(result.structuredContent?.isolation).toBeUndefined();

    await expectToolError(
      topLevel,
      { isolation: { worktree: false, reason: "not allowed here" }, background: true },
      /isolation/i,
    );
    expect(worktreePaths(repoDir)).toEqual(before);
  });

  test("parallel subagents each get their own worktree branched from the caller's branch", async () => {
    const repoDir = createRepo("parallel-repo");
    const parent = await createHumanAgent(repoDir, "Orchestrator");
    const mcp = await mcpClientFor(parent.id);
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);

    const [first, second] = await Promise.all([
      createSubagent(mcp, { title: "First" }),
      createSubagent(mcp, { title: "Second" }),
    ]);

    const firstCwd = realpathSync(first.record.cwd);
    const secondCwd = realpathSync(second.record.cwd);
    expect(firstCwd).not.toBe(repoDir);
    expect(secondCwd).not.toBe(repoDir);
    expect(firstCwd).not.toBe(secondCwd);
    expect(worktreePaths(repoDir)).toEqual(expect.arrayContaining([firstCwd, secondCwd]));
    expect(first.record.workspaceId).not.toBe(parent.workspaceId);
    expect(second.record.workspaceId).not.toBe(parent.workspaceId);
    expect(first.record.workspaceId).not.toBe(second.record.workspaceId);

    for (const child of [first, second]) {
      const cwd = child.record.cwd;
      expect(git(cwd, ["rev-parse", "HEAD"])).toBe(baseCommit);
      expect(git(cwd, ["branch", "--show-current"])).not.toBe("feature/base");
      expect(child.record.labels[PARENT_AGENT_ID_LABEL]).toBe(parent.id);
      expect(child.record.labels[ISOLATION_WORKTREE_LABEL]).toBe("created");
      expect(child.content.isolation).toEqual({ worktree: "created" });
    }
    expect(git(firstCwd, ["branch", "--show-current"])).not.toBe(
      git(secondCwd, ["branch", "--show-current"]),
    );
    // The source checkout is untouched.
    expect(git(repoDir, ["branch", "--show-current"])).toBe("feature/base");
    expect(git(repoDir, ["status", "--porcelain"])).toBe("");
    expect(isolationLogEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: first.record.id,
          callerAgentId: parent.id,
          worktree: "created",
          baseRef: "refs/heads/feature/base",
        }),
      ]),
    );
  });

  test("selecting a workspace or a legacy placement still isolates the subagent", async () => {
    const repoDir = createRepo("placement-repo");
    const parent = await createHumanAgent(repoDir, "Orchestrator");
    const mcp = await mcpClientFor(parent.id);

    const explicit = await createSubagent(mcp, { workspaceId: parent.workspaceId });
    expect(realpathSync(explicit.record.cwd)).not.toBe(repoDir);
    expect(explicit.record.workspaceId).not.toBe(parent.workspaceId);

    const legacyCurrent = await createSubagent(mcp, {
      relationship: { kind: "subagent" },
      workspace: { kind: "current" },
    });
    expect(realpathSync(legacyCurrent.record.cwd)).not.toBe(repoDir);
    expect(legacyCurrent.record.labels[ISOLATION_WORKTREE_LABEL]).toBe("created");

    const workspacesBefore = await activeWorkspaceIds();
    const legacyDirectory = await createSubagent(mcp, {
      relationship: { kind: "detached" },
      workspace: { kind: "create", source: { kind: "directory", path: repoDir } },
    });
    expect(realpathSync(legacyDirectory.record.cwd)).not.toBe(repoDir);
    // Only the worktree workspace is created; no directory workspace is minted first.
    const workspacesAfter = await activeWorkspaceIds();
    expect(workspacesAfter.filter((id) => !workspacesBefore.includes(id))).toEqual([
      legacyDirectory.record.workspaceId,
    ]);
  });

  test("caller labels cannot forge the isolation record", async () => {
    const repoDir = createRepo("spoof-repo");
    const parent = await createHumanAgent(repoDir, "Orchestrator");
    const mcp = await mcpClientFor(parent.id);

    const child = await createSubagent(mcp, {
      labels: {
        [ISOLATION_WORKTREE_LABEL]: "opted-out",
        [ISOLATION_REASON_LABEL]: "forged",
        purpose: "review",
      },
    });
    expect(child.record.labels[ISOLATION_WORKTREE_LABEL]).toBe("created");
    expect(child.record.labels[ISOLATION_REASON_LABEL]).toBeUndefined();
    expect(child.record.labels.purpose).toBe("review");
    expect(realpathSync(child.record.cwd)).not.toBe(repoDir);
  });

  test("opting out requires a single-line reason and records it", async () => {
    const repoDir = createRepo("opt-out-repo");
    const parent = await createHumanAgent(repoDir, "Orchestrator");
    const mcp = await mcpClientFor(parent.id);
    const worktreesBefore = worktreePaths(repoDir);
    const agentsBefore = (await daemon.daemon.agentStorage.list()).length;

    await expectToolError(mcp, { isolation: { worktree: false } }, /non-empty reason/);
    await expectToolError(mcp, { isolation: { worktree: false, reason: "   " } }, /non-empty/);
    await expectToolError(
      mcp,
      { isolation: { worktree: false, reason: "line one\nline two" } },
      /single line/,
    );
    await expectToolError(
      mcp,
      { isolation: { worktree: false, reason: "x".repeat(201) } },
      /200 characters/,
    );
    await expectToolError(
      mcp,
      { isolation: { worktree: true, reason: "unneeded" } },
      /only accepted together with worktree: false/,
    );
    await expectToolError(
      mcp,
      {
        relationship: { kind: "subagent" },
        workspace: {
          kind: "create",
          source: { kind: "worktree", target: { kind: "branch-off", branchName: "explicit" } },
        },
        isolation: { worktree: false, reason: "contradiction" },
      },
      /cannot be combined with an explicit new worktree/,
    );
    expect(worktreePaths(repoDir)).toEqual(worktreesBefore);
    expect((await daemon.daemon.agentStorage.list()).length).toBe(agentsBefore);

    const reason = "read-only review of the orchestrator's uncommitted diff";
    const child = await createSubagent(mcp, { isolation: { worktree: false, reason } });
    expect(realpathSync(child.record.cwd)).toBe(repoDir);
    expect(child.record.workspaceId).toBe(parent.workspaceId);
    expect(child.record.labels[ISOLATION_WORKTREE_LABEL]).toBe("opted-out");
    expect(child.record.labels[ISOLATION_REASON_LABEL]).toBe(reason);
    expect(child.content.isolation).toEqual({ worktree: "opted-out", reason });
    expect(worktreePaths(repoDir)).toEqual(worktreesBefore);
    expect(isolationLogEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: child.record.id,
          callerAgentId: parent.id,
          worktree: "opted-out",
          reason,
        }),
      ]),
    );
  });

  test("a non-git source falls back to the directory with a note", async () => {
    const dir = createPlainDirectory("plain-dir");
    const parent = await createHumanAgent(dir, "Plain orchestrator");
    const mcp = await mcpClientFor(parent.id);

    const child = await createSubagent(mcp);
    expect(realpathSync(child.record.cwd)).toBe(dir);
    expect(child.record.workspaceId).toBe(parent.workspaceId);
    expect(child.record.labels[ISOLATION_WORKTREE_LABEL]).toBe("not-git");
    expect(child.content.isolation).toEqual({
      worktree: "not-git",
      note: expect.stringContaining("not inside a git repository"),
    });
  });

  test("a failed create removes the subagent's fresh worktree", async () => {
    const repoDir = createRepo("failed-create-repo");
    const parent = await createHumanAgent(repoDir, "Orchestrator");
    const mcp = await mcpClientFor(parent.id);
    const worktreesBefore = worktreePaths(repoDir);
    const workspacesBefore = await activeWorkspaceIds();

    await expectToolError(mcp, { settings: { modeId: "no-such-mode" } }, /mode/i);

    expect(worktreePaths(repoDir)).toEqual(worktreesBefore);
    expect(await activeWorkspaceIds()).toEqual(workspacesBefore);
  });

  test("archiving keeps the subagent worktree, and parent archive cascades to it", async () => {
    const repoDir = createRepo("archive-repo");
    const parent = await createHumanAgent(repoDir, "Orchestrator");
    const mcp = await mcpClientFor(parent.id);

    const archivedDirectly = await createSubagent(mcp, { title: "Archived directly" });
    await client.archiveAgent(archivedDirectly.record.id);
    expect(existsSync(archivedDirectly.record.cwd)).toBe(true);
    expect(await activeWorkspaceIds()).toContain(archivedDirectly.record.workspaceId);
    expect(logLines.join("\n")).toContain("Archived subagent keeps its worktree workspace");

    const cascaded = await createSubagent(mcp, { title: "Cascaded" });
    await client.archiveAgent(parent.id);
    await expect
      .poll(async () => (await daemon.daemon.agentStorage.get(cascaded.record.id))?.archivedAt)
      .toBeTruthy();
    const cascadedRecord = await daemon.daemon.agentStorage.get(cascaded.record.id);
    expect(cascadedRecord?.labels[PARENT_AGENT_ID_LABEL]).toBe(parent.id);
    expect(existsSync(cascaded.record.cwd)).toBe(true);
    expect(worktreePaths(repoDir)).toContain(realpathSync(cascaded.record.cwd));
  });
});

describe("paseo run with PASEO_AGENT_ID (create_agent_request callerAgentId)", () => {
  async function createCliSubagent(
    callerAgentId: string | undefined,
    cwd: string,
    extra: Record<string, unknown> = {},
  ) {
    return client.createAgent({
      provider: PROVIDER,
      model: MODEL,
      modeId: MODE,
      cwd,
      ...(callerAgentId ? { callerAgentId } : {}),
      title: "CLI subagent",
      ...extra,
    });
  }

  test("defaults to a new worktree and records an opt-out with its reason", async () => {
    const repoDir = createRepo("cli-repo");
    const parent = await createHumanAgent(repoDir, "CLI orchestrator");

    const [first, second] = await Promise.all([
      createCliSubagent(parent.id, repoDir),
      createCliSubagent(parent.id, repoDir),
    ]);
    for (const child of [first, second]) {
      expect(realpathSync(child.cwd)).not.toBe(repoDir);
      expect(child.workspaceId).not.toBe(parent.workspaceId);
      expect(child.labels[ISOLATION_WORKTREE_LABEL]).toBe("created");
      expect(child.labels[PARENT_AGENT_ID_LABEL]).toBe(parent.id);
      expect(git(child.cwd, ["rev-parse", "HEAD"])).toBe(git(repoDir, ["rev-parse", "HEAD"]));
    }
    expect(realpathSync(first.cwd)).not.toBe(realpathSync(second.cwd));

    // Selecting the caller's workspace only names the source checkout.
    const selected = await createCliSubagent(parent.id, repoDir, {
      workspaceId: parent.workspaceId,
    });
    expect(realpathSync(selected.cwd)).not.toBe(repoDir);

    const worktreesBefore = worktreePaths(repoDir);
    await expect(
      createCliSubagent(parent.id, repoDir, { isolation: { worktree: false } }),
    ).rejects.toThrow(/non-empty reason/);
    await expect(
      createCliSubagent(parent.id, repoDir, {
        isolation: { worktree: false, reason: "contradiction" },
        worktree: { mode: "branch-off", newBranch: "explicit-cli" },
      }),
    ).rejects.toThrow(/cannot be combined with an explicit new worktree/);
    expect(worktreePaths(repoDir)).toEqual(worktreesBefore);

    const reason = "pair on the same checkout";
    const shared = await createCliSubagent(parent.id, repoDir, {
      isolation: { worktree: false, reason },
    });
    expect(realpathSync(shared.cwd)).toBe(repoDir);
    expect(shared.workspaceId).toBe(parent.workspaceId);
    expect(shared.labels[ISOLATION_WORKTREE_LABEL]).toBe("opted-out");
    expect(shared.labels[ISOLATION_REASON_LABEL]).toBe(reason);
    expect(isolationLogEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: shared.id, worktree: "opted-out", reason }),
      ]),
    );
  });

  test("a failed create removes the default worktree; a dedicated worktree workspace is reused", async () => {
    const repoDir = createRepo("cli-failure-repo");
    const parent = await createHumanAgent(repoDir, "CLI orchestrator");
    const worktreesBefore = worktreePaths(repoDir);
    const workspacesBefore = await activeWorkspaceIds();

    await expect(createCliSubagent(parent.id, repoDir, { modeId: "no-such-mode" })).rejects.toThrow(
      /mode/i,
    );
    expect(worktreePaths(repoDir)).toEqual(worktreesBefore);
    expect(await activeWorkspaceIds()).toEqual(workspacesBefore);

    // A worktree workspace created together with its first agent already isolates it.
    const created = await client.createWorkspace({
      source: { kind: "worktree", cwd: repoDir },
      agent: {
        provider: PROVIDER,
        model: MODEL,
        modeId: MODE,
        cwd: repoDir,
        callerAgentId: parent.id,
        title: "Workspace-first subagent",
      },
    });
    const agent = created.agent;
    if (!agent || !created.workspace) throw new Error(created.error ?? "workspace create failed");
    expect(agent.workspaceId).toBe(created.workspace.id);
    expect(realpathSync(agent.cwd)).toBe(realpathSync(created.workspace.workspaceDirectory ?? ""));
    expect(agent.labels[ISOLATION_WORKTREE_LABEL]).toBe("created");
    expect(worktreePaths(repoDir)).toHaveLength(worktreesBefore.length + 1);
  });

  test("auto-archive keeps a subagent's default worktree", async () => {
    const repoDir = createRepo("cli-auto-archive-repo");
    const parent = await createHumanAgent(repoDir, "CLI orchestrator");
    const child = await createCliSubagent(parent.id, repoDir, {
      autoArchive: true,
      initialPrompt: "Say done.",
    });
    expect(realpathSync(child.cwd)).not.toBe(repoDir);

    await expect
      .poll(async () => (await daemon.daemon.agentStorage.get(child.id))?.archivedAt, {
        timeout: 15_000,
      })
      .toBeTruthy();
    expect(existsSync(child.cwd)).toBe(true);
    expect(await activeWorkspaceIds()).toContain(child.workspaceId);
  });

  test("an explicit worktree request is used as the subagent's worktree", async () => {
    const repoDir = createRepo("cli-explicit-repo");
    const parent = await createHumanAgent(repoDir, "CLI orchestrator");
    const child = await createCliSubagent(parent.id, repoDir, {
      worktree: { mode: "branch-off", newBranch: "explicit-cli-branch" },
    });
    expect(git(child.cwd, ["branch", "--show-current"])).toBe("explicit-cli-branch");
    expect(child.labels[ISOLATION_WORKTREE_LABEL]).toBe("created");
    expect(worktreePaths(repoDir)).toHaveLength(2);
  });

  test("non-git callers share the directory; human requests reject isolation", async () => {
    const dir = createPlainDirectory("cli-plain");
    const parent = await createHumanAgent(dir, "Plain CLI orchestrator");
    const child = await createCliSubagent(parent.id, dir);
    expect(realpathSync(child.cwd)).toBe(dir);
    expect(child.labels[ISOLATION_WORKTREE_LABEL]).toBe("not-git");

    await expect(
      createCliSubagent(undefined, dir, {
        workspaceId: parent.workspaceId,
        isolation: { worktree: false, reason: "human" },
      }),
    ).rejects.toThrow(/only to agent-created agents/);
  });
});
