import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAgentScopedRunRequest,
  resolveExistingRunWorkspace,
  resolveRunCallerAgentId,
  runRunCommand,
  type AgentRunOptions,
} from "./run";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

describe("managed agent caller context", () => {
  it("propagates a trimmed PASEO_AGENT_ID", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "  parent-agent  " })).toBe("parent-agent");
  });

  it("omits blank caller ids", () => {
    expect(resolveRunCallerAgentId({ PASEO_AGENT_ID: "   " })).toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;
  const originalAgentId = process.env.PASEO_AGENT_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
    delete process.env.PASEO_AGENT_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
    if (originalAgentId === undefined) {
      delete process.env.PASEO_AGENT_ID;
    } else {
      process.env.PASEO_AGENT_ID = originalAgentId;
    }
  });

  async function expectInvalidOptions(
    options: Omit<AgentRunOptions, "daemonTarget">,
    messageMatch: RegExp,
  ) {
    await expect(
      runRunCommand("do something", { ...options, daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand(
        "do something",
        { newWorkspace: "worktree", provider: undefined, daemonTarget },
        {} as never,
      ),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });

  it("rejects --share-checkout outside an agent-scoped run before connecting", async () => {
    await expectInvalidOptions({ shareCheckout: "pairing" }, /only applies to agent-scoped runs/);
  });

  it("requires --share-checkout for an agent-scoped local workspace before connecting", async () => {
    process.env.PASEO_AGENT_ID = "parent-agent";
    await expectInvalidOptions({ newWorkspace: "local" }, /would share the checkout/);
  });
});

describe("agent-scoped run placement", () => {
  const run = (options: Omit<AgentRunOptions, "daemonTarget">, callerAgentId?: string) =>
    resolveAgentScopedRunRequest({ ...options, daemonTarget }, callerAgentId);

  it("leaves human runs unchanged", () => {
    expect(run({})).toBeNull();
    expect(run({ newWorkspace: "local" })).toBeNull();
    expect(run({ newWorkspace: "worktree", newBranch: "x" })).toBeNull();
  });

  it("lets the daemon create the default worktree instead of pre-creating a workspace", () => {
    expect(run({}, "parent")).toEqual({ createLocalWorkspace: false });
    expect(run({ workspace: "wks_source" }, "parent")).toEqual({ createLocalWorkspace: false });
    expect(run({ newWorkspace: "worktree" }, "parent")).toEqual({ createLocalWorkspace: false });
  });

  it("forwards explicit worktree targets to the daemon", () => {
    expect(run({ newWorkspace: "worktree", newBranch: "feat/x", base: "main" }, "parent")).toEqual({
      createLocalWorkspace: false,
      worktree: { mode: "branch-off", newBranch: "feat/x", base: "main" },
    });
    expect(run({ worktree: "legacy-slug" }, "parent")).toEqual({
      createLocalWorkspace: false,
      worktree: { mode: "branch-off", newBranch: "legacy-slug" },
    });
    expect(
      run({ newWorkspace: "worktree", worktreeMode: "checkout-branch", branch: "dev" }, "parent"),
    ).toEqual({
      createLocalWorkspace: false,
      worktree: { mode: "checkout-branch", branch: "dev" },
    });
    expect(
      run({ newWorkspace: "worktree", worktreeMode: "checkout-pr", prNumber: "12" }, "parent"),
    ).toEqual({ createLocalWorkspace: false, worktree: { mode: "checkout-pr", prNumber: 12 } });
  });

  it("records an opt-out reason and rejects contradictory or unsupported options", () => {
    expect(run({ shareCheckout: "  pairing  " }, "parent")).toEqual({
      createLocalWorkspace: false,
      isolation: { worktree: false, reason: "pairing" },
    });
    expect(run({ newWorkspace: "local", shareCheckout: "pairing" }, "parent")).toEqual({
      createLocalWorkspace: true,
      isolation: { worktree: false, reason: "pairing" },
    });
    const invalid: Array<[Omit<AgentRunOptions, "daemonTarget">, RegExp]> = [
      [{ shareCheckout: "   " }, /requires a reason/],
      [{ newWorkspace: "worktree", shareCheckout: "x" }, /cannot be combined/],
      [{ newWorkspace: "worktree", base: "main" }, /--base requires --new-branch/],
      [{ newWorkspace: "worktree", forge: "github" }, /--forge is not supported/],
      [{ newWorkspace: "worktree", worktreeSlug: "a", newBranch: "b" }, /cannot differ/],
    ];
    for (const [options, message] of invalid) {
      expect(() => run(options, "parent")).toThrow(
        expect.objectContaining({
          code: "INVALID_OPTIONS",
          message: expect.stringMatching(message),
        }),
      );
    }
  });
});
