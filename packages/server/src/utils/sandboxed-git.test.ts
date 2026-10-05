import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runGitCommand } from "./run-git-command.js";
import {
  protectSandboxedCheckout,
  resetSandboxedCheckoutsForTests,
  sandboxedGitInvocation,
  sandboxedGitWrapperFor,
} from "./sandboxed-git.js";

afterEach(() => resetSandboxedCheckoutsForTests());

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

const wrapper = {
  nono: "/opt/nono",
  git: "/usr/bin/git",
  readPaths: ["/repo/.git"],
  readFiles: [],
};

describe("sandboxed checkout guard", () => {
  it("covers the checkout and its subdirectories, not path-prefix siblings", () => {
    protectSandboxedCheckout("/work/agent", async () => wrapper);
    expect(sandboxedGitWrapperFor("/work/agent")).not.toBeNull();
    expect(sandboxedGitWrapperFor("/work/agent/src/deep")).not.toBeNull();
    expect(sandboxedGitWrapperFor("/work/agent-sibling")).toBeNull();
    expect(sandboxedGitWrapperFor("/work")).toBeNull();
  });

  it("runs git read-only without network and with no writable grant", () => {
    const invocation = sandboxedGitInvocation(wrapper, "/work/agent", ["status", "--porcelain"]);
    expect(invocation.command).toBe("/opt/nono");
    expect(invocation.args).toEqual([
      "run",
      "--silent",
      "--no-rollback",
      "--no-audit",
      "--no-diagnostics",
      "--block-net",
      "--read",
      "/work/agent",
      "--read",
      "/repo/.git",
      "--",
      "/usr/bin/git",
      "status",
      "--porcelain",
    ]);
    expect(invocation.args.some((arg) => arg === "--allow" || arg === "--write")).toBe(false);
  });

  it("routes runGitCommand through the wrapper only inside a protected checkout", async () => {
    const root = tempDir("paseo-sandboxed-git-");
    const protectedRepo = path.join(root, "protected");
    const plainRepo = path.join(root, "plain");
    for (const repo of [protectedRepo, plainRepo]) {
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
    }
    const log = path.join(root, "nono-argv.log");
    const fakeNono = path.join(root, "nono");
    // Records its argv, then runs the command after "--" exactly as nono would.
    writeFileSync(
      fakeNono,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
      { mode: 0o755 },
    );
    protectSandboxedCheckout(protectedRepo, async () => ({
      nono: fakeNono,
      git: "git",
      readPaths: [],
      readFiles: [],
    }));

    const inside = await runGitCommand(["rev-parse", "--show-toplevel"], { cwd: protectedRepo });
    expect(inside.stdout.trim()).toBe(protectedRepo);
    const outside = await runGitCommand(["rev-parse", "--show-toplevel"], { cwd: plainRepo });
    expect(outside.stdout.trim()).toBe(plainRepo);

    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(
      `--block-net --read ${protectedRepo} -- git -c core.quotepath=false`,
    );
  });

  it("fails closed when the wrapper cannot be resolved", async () => {
    const root = tempDir("paseo-sandboxed-git-missing-");
    protectSandboxedCheckout(root, async () => {
      throw new Error("nono is not installed on PATH");
    });
    await expect(runGitCommand(["status"], { cwd: root })).rejects.toThrow(/nono is not installed/);
  });
});
