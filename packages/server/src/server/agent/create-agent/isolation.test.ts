import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ISOLATION_REASON_LABEL, ISOLATION_WORKTREE_LABEL } from "@getpaseo/protocol/agent-labels";

import { resolveSubagentWorktreeDecision, withIsolationLabels } from "./isolation.js";

const roots: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-isolation-unit-")));
  roots.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}

function initRepo(withCommit: boolean): string {
  const dir = tempDir();
  git(dir, ["init", "-b", "main"]);
  if (withCommit) {
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, ["add", "README.md"]);
    git(dir, [
      "-c",
      "user.email=test@getpaseo.local",
      "-c",
      "user.name=Paseo Test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "initial",
    ]);
  }
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveSubagentWorktreeDecision", () => {
  it("branches from the current branch, or the commit when HEAD is detached", async () => {
    const repo = initRepo(true);
    await expect(
      resolveSubagentWorktreeDecision({
        request: undefined,
        sourceCwd: repo,
        explicitWorktree: false,
      }),
    ).resolves.toEqual({ kind: "worktree", sourceCwd: repo, baseRef: "refs/heads/main" });

    const commit = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["checkout", "--detach"]);
    await expect(
      resolveSubagentWorktreeDecision({
        request: undefined,
        sourceCwd: repo,
        explicitWorktree: false,
      }),
    ).resolves.toEqual({ kind: "worktree", sourceCwd: repo, baseRef: commit });
  });

  it("treats a directory outside git as not-git and refuses an unborn repository", async () => {
    const plain = tempDir();
    await expect(
      resolveSubagentWorktreeDecision({
        request: undefined,
        sourceCwd: plain,
        explicitWorktree: false,
      }),
    ).resolves.toEqual({ kind: "not-git", sourceCwd: plain });

    // HEAD names a branch with no commit yet; there is nothing to branch from.
    const unborn = initRepo(false);
    await expect(
      resolveSubagentWorktreeDecision({
        request: undefined,
        sourceCwd: unborn,
        explicitWorktree: false,
      }),
    ).rejects.toThrow(/HEAD has no commit.*isolation \{ worktree: false, reason \}/);
  });

  it("does not inspect git when the caller opts out or asks for a worktree explicitly", async () => {
    const missing = join(tempDir(), "does-not-exist");
    await expect(
      resolveSubagentWorktreeDecision({
        request: { worktree: false, reason: "  shared on purpose  " },
        sourceCwd: missing,
        explicitWorktree: false,
      }),
    ).resolves.toEqual({ kind: "opted-out", sourceCwd: missing, reason: "shared on purpose" });
    await expect(
      resolveSubagentWorktreeDecision({
        request: undefined,
        sourceCwd: missing,
        explicitWorktree: true,
      }),
    ).resolves.toEqual({ kind: "requested", sourceCwd: missing });
  });

  it("rejects malformed opt-outs", async () => {
    const cases: Array<[{ worktree: boolean; reason?: string }, RegExp]> = [
      [{ worktree: false }, /non-empty reason/],
      [{ worktree: false, reason: " \t " }, /non-empty reason/],
      [{ worktree: false, reason: "one\ntwo" }, /single line/],
      [{ worktree: false, reason: "tab\there" }, /single line/],
      [{ worktree: false, reason: "x".repeat(201) }, /200 characters/],
      [{ worktree: true, reason: "why" }, /only accepted together with worktree: false/],
    ];
    for (const [request, pattern] of cases) {
      await expect(
        resolveSubagentWorktreeDecision({ request, sourceCwd: "/", explicitWorktree: false }),
      ).rejects.toThrow(pattern);
    }
    await expect(
      resolveSubagentWorktreeDecision({
        request: { worktree: false, reason: "x".repeat(200) },
        sourceCwd: "/",
        explicitWorktree: false,
      }),
    ).resolves.toMatchObject({ kind: "opted-out" });
  });
});

describe("withIsolationLabels", () => {
  it("drops caller-supplied isolation labels and stamps the decision", () => {
    expect(
      withIsolationLabels(
        {
          [ISOLATION_WORKTREE_LABEL]: "opted-out",
          [ISOLATION_REASON_LABEL]: "forged",
          "paseo.isolation.other": "forged",
          purpose: "review",
        },
        { kind: "worktree", sourceCwd: "/repo", baseRef: "refs/heads/main" },
      ),
    ).toEqual({ purpose: "review", [ISOLATION_WORKTREE_LABEL]: "created" });
  });
});
