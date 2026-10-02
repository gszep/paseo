import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blameProvenance,
  provenanceRefForSession,
  removeProvenance,
  writeProvenance,
} from "./provenance.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function initRepo() {
  const root = mkdtempSync(join(tmpdir(), "chi-provenance-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "chi@example.com");
  git("config", "user.name", "Chi Test");
  writeFileSync(join(root, "app.ts"), "const a = 1;\n");
  git("add", "app.ts");
  git("commit", "-m", "init");
  // Native Windows cannot execute the POSIX scanner fixture. CI installs the
  // checksum-pinned production scanner there; Git/ref assertions stay identical.
  const scanner = process.platform === "win32" ? "gitleaks.exe" : join(root, "fake-gitleaks.sh");
  if (process.platform !== "win32") {
    writeFileSync(scanner, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(scanner, 0o755);
  }
  return { root, git, scanner };
}

describe("daemon provenance writer", () => {
  it("normalizes the ref namespace", () => {
    expect(provenanceRefForSession("github:Alice Smith", "ses_1")).toBe(
      "refs/chi/provenance/alice-smith/ses_1",
    );
  });

  it("records delegation origin and native turn coordinates, then purges locally", async () => {
    const { root, git, scanner } = initRepo();
    writeFileSync(join(root, "app.ts"), "const a = 1;\nconst b = 2;\n");
    const outcome = await writeProvenance({
      root,
      user: "github:alice",
      sessionId: "ses_child",
      repo: "github:fixture/repo",
      sourceId: "a".repeat(64),
      head: "b".repeat(64),
      evidence: {
        nativeSessionId: "ses_child",
        nativeParent: null,
        entries: [
          { nativeId: "u1", type: "user", parentId: null },
          { nativeId: "a1", type: "assistant", parentId: "u1" },
        ],
      },
      delegation: { parentSessionId: "ses_parent", turnId: "turn-9" },
      scanner,
    });
    expect(outcome.created).toBe(true);
    expect(outcome.ref).toBe("refs/chi/provenance/alice/ses_child");

    const message = git("log", "-1", "--format=%B", "refs/chi/provenance/alice/ses_child");
    expect(message).toMatch(/^origin: delegation$/m);
    expect(message).toMatch(/^origin-ref: ses_parent#turn-9$/m);
    expect(message).toMatch(/^turn-id: a1$/m);
    expect(message).toMatch(/^parent-turn-id: u1$/m);
    expect(message).toMatch(/^user-request-id: u1$/m);

    const blame = await blameProvenance({ root, ref: outcome.ref, file: "app.ts" });
    const changed = blame.rows.find((row) => row.content === "const b = 2;");
    expect(changed?.origin).toBe("delegation");
    expect(changed?.userRequestId).toBe("u1");
    expect(blame.rendered).toContain("delegation");

    const removal = await removeProvenance({ root, user: "github:alice", sessionId: "ses_child" });
    expect(removal.ref).toBe(outcome.ref);
    expect(git("for-each-ref", "--format=%(refname)", "refs/chi/provenance/")).toBe("");
  });

  it("marks a continued session against its predecessor", async () => {
    const { root, git, scanner } = initRepo();
    writeFileSync(join(root, "app.ts"), "const a = 1;\nconst c = 3;\n");
    const outcome = await writeProvenance({
      root,
      user: "bob",
      sessionId: "ses_cont",
      repo: "github:fixture/repo",
      sourceId: "a".repeat(64),
      head: "b".repeat(64),
      evidence: {
        nativeSessionId: "ses_cont",
        nativeParent: { kind: "session-id", value: "ses_origin" },
        entries: [
          { nativeId: "u2", type: "user", parentId: null },
          { nativeId: "a2", type: "assistant", parentId: "u2" },
        ],
      },
      continuation: true,
      scanner,
    });
    expect(outcome.created).toBe(true);
    const message = git("log", "-1", "--format=%B", outcome.ref);
    expect(message).toMatch(/^origin: continue$/m);
    expect(message).toMatch(/^origin-ref: ses_origin$/m);
  });
});
