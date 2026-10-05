import { describe, expect, it } from "vitest";

import {
  AgentIsolationSchema,
  isSandboxed,
  newSubagentBranch,
  SANDBOXED_AGENT_PASEO_TOOLS,
  subagentBranchName,
} from "./subagent-isolation.js";

describe("agent isolation record", () => {
  it("accepts only the recorded vocabulary", () => {
    expect(
      AgentIsolationSchema.parse({ worktree: "created", sandbox: "nono", decidedBy: "parent" }),
    ).toEqual({ worktree: "created", sandbox: "nono", decidedBy: "parent" });
    expect(() =>
      AgentIsolationSchema.parse({ worktree: "created", sandbox: "maybe", decidedBy: "parent" }),
    ).toThrow();
    expect(() =>
      AgentIsolationSchema.parse({
        worktree: "created",
        sandbox: "nono",
        decidedBy: "parent",
        extra: true,
      }),
    ).toThrow();
  });

  it("treats only an explicit nono record as sandboxed", () => {
    expect(isSandboxed({ worktree: "created", sandbox: "nono", decidedBy: "p" })).toBe(true);
    expect(
      isSandboxed({ worktree: "created", sandbox: "opted-out", reason: "x", decidedBy: "p" }),
    ).toBe(false);
    expect(isSandboxed(undefined)).toBe(false);
  });
});

describe("subagent branches", () => {
  it("give each sandboxed subagent its own ref directory", () => {
    expect(subagentBranchName("subagent-1a2b3c4d")).toBe("paseo-subagents/subagent-1a2b3c4d/work");
    const first = newSubagentBranch();
    const second = newSubagentBranch();
    expect(first.slug).toMatch(/^subagent-[0-9a-f]{8}$/);
    expect(first.name).toBe(subagentBranchName(first.slug));
    expect(first.slug).not.toBe(second.slug);
  });
});

describe("SANDBOXED_AGENT_PASEO_TOOLS", () => {
  it("excludes every daemon-side execution and cross-agent mutation tool", () => {
    for (const tool of [
      "create_terminal",
      "send_terminal_keys",
      "capture_terminal",
      "start_workspace_script",
      "create_schedule",
      "create_heartbeat",
      "run_schedule_once",
      "send_agent_prompt",
      "respond_to_permission",
      "archive_workspace",
      "create_workspace",
      "update_agent",
      "kill_agent",
    ]) {
      expect(SANDBOXED_AGENT_PASEO_TOOLS.has(tool)).toBe(false);
    }
  });
});
