import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSandboxProfile,
  gitHubRoutes,
  hostTempDenyPaths,
  isGitLayout,
  localPluginDirs,
  NONO_VERSION,
  prepareSandboxLaunch,
  protectSandboxedCheckouts,
  resolveNono,
  sandboxPaths,
  SandboxUnavailableError,
  type ProxyCredentialRoute,
} from "./nono.js";
import {
  resetSandboxedCheckoutsForTests,
  sandboxedGitWrapperFor,
} from "../../../utils/sandboxed-git.js";

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  })
    .toString()
    .trim();
}

const bridgeRoute: ProxyCredentialRoute = {
  name: "paseo_bridge",
  upstream: "http://127.0.0.1:4100",
  envVar: "PASEO_BRIDGE_TOKEN",
  mode: "bearer",
  secret: "real-bridge-secret",
};

describe("resolveNono", () => {
  it("fails closed when nono is missing or not the pinned release", async () => {
    await expect(resolveNono(async () => null)).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      resolveNono(
        async () => "/opt/nono",
        async () => "nono 0.78.0\n",
      ),
    ).rejects.toThrow(/reports "nono 0.78.0", expected nono 0.79.0/);
    await expect(
      resolveNono(
        async () => "/opt/nono",
        async () => {
          throw new Error("exec failed");
        },
      ),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(
      resolveNono(
        async () => "/opt/nono",
        async () => `nono ${NONO_VERSION}\n`,
      ),
    ).resolves.toBe("/opt/nono");
  });

  it("tells the caller how to proceed without sandboxing silently", async () => {
    await expect(resolveNono(async () => null)).rejects.toThrow(
      /isolation\.sandbox: false and a reason/,
    );
  });
});

describe("buildSandboxProfile", () => {
  const paths = sandboxPaths("/paseo", "agent-1");
  const worktree = "/work/subagent-1";
  const git = {
    gitDir: "/repo/.git/worktrees/subagent-1",
    commonDir: "/repo/.git",
    branch: "paseo-subagents/subagent-1/work",
  };

  it("grants the worktree and private state but keeps the shared repository read-only", () => {
    const profile = buildSandboxProfile({
      agentId: "agent-1",
      cwd: worktree,
      paths,
      executableDirs: ["/opt/opencode/bin"],
      git,
      routes: [],
    }) as {
      filesystem: { allow: string[]; read: string[] };
      linux: Record<string, unknown>;
      environment: { set_vars: Record<string, string> };
    };
    expect(profile.filesystem.allow).toEqual([
      worktree,
      paths.config,
      paths.data,
      paths.cache,
      paths.state,
      paths.tmp,
      git.gitDir,
      "/repo/.git/objects",
      "/repo/.git/refs/heads/paseo-subagents/subagent-1",
      "/repo/.git/logs/refs/heads/paseo-subagents/subagent-1",
    ]);
    expect(profile.filesystem.read).toEqual(["/opt/opencode/bin", "/repo/.git"]);
    // Hooks and config stay outside every writable grant.
    for (const writable of profile.filesystem.allow) {
      expect(writable).not.toBe("/repo/.git");
      expect(writable.startsWith("/repo/.git/hooks")).toBe(false);
      expect(writable).not.toBe("/repo/.git/refs/heads/paseo-subagents");
    }
    // The private HOME is never a grant: nono protects its own state beneath HOME.
    expect(profile.filesystem.allow).not.toContain(paths.home);
    expect(profile.linux).toEqual({ af_unix_mediation: "pathname" });
    expect(profile.environment.set_vars).toMatchObject({
      HOME: paths.home,
      XDG_CONFIG_HOME: paths.config,
      XDG_DATA_HOME: paths.data,
      TMPDIR: paths.tmp,
      NO_PROXY: "127.0.0.1,localhost",
    });
  });

  it("lets OpenCode realpath the main checkout on macOS without exposing its files", () => {
    const base = { agentId: "agent-1", cwd: worktree, paths, executableDirs: [], routes: [] };
    const mac = buildSandboxProfile({ ...base, git, platform: "darwin" }) as Record<
      string,
      unknown
    >;
    expect(mac.unsafe_macos_seatbelt_rules).toEqual(['(allow file-read* (literal "/repo"))']);
    const linux = buildSandboxProfile({ ...base, git, platform: "linux" }) as Record<
      string,
      unknown
    >;
    expect(linux.unsafe_macos_seatbelt_rules).toBeUndefined();
    const quoted = buildSandboxProfile({
      ...base,
      git: { ...git, commonDir: '/we"ird\\repo/.git' },
      platform: "darwin",
    }) as Record<string, unknown>;
    // A crafted path cannot close the string and append its own rule.
    expect(quoted.unsafe_macos_seatbelt_rules).toEqual([
      '(allow file-read* (literal "/we\\"ird\\\\repo"))',
    ]);
  });

  it("never grants a whole refs/heads directory for an unscoped branch", () => {
    const profile = buildSandboxProfile({
      agentId: "agent-1",
      cwd: worktree,
      paths,
      executableDirs: [],
      git: { ...git, branch: "main" },
      routes: [],
    }) as { filesystem: { allow: string[] } };
    expect(profile.filesystem.allow.some((entry) => entry.includes("/refs/heads"))).toBe(false);
  });

  it("sources each credential from the variable nono replaces with a phantom", () => {
    const profile = buildSandboxProfile({
      agentId: "agent-1",
      cwd: worktree,
      paths,
      executableDirs: [],
      git: null,
      routes: [
        bridgeRoute,
        {
          name: "github_git",
          upstream: "https://github.com",
          envVar: "PASEO_GITHUB_GIT_TOKEN",
          mode: "basic",
          secret: "x-access-token:t",
        },
      ],
    }) as { network: Record<string, unknown> };
    expect(profile.network).toEqual({
      allow_domain: expect.any(Array),
      credentials: ["paseo_bridge", "github_git"],
      custom_credentials: {
        paseo_bridge: {
          upstream: "http://127.0.0.1:4100",
          credential_key: "env://PASEO_BRIDGE_TOKEN",
          env_var: "PASEO_BRIDGE_TOKEN",
          inject_header: "Authorization",
          credential_format: "Bearer {}",
        },
        github_git: {
          upstream: "https://github.com",
          credential_key: "env://PASEO_GITHUB_GIT_TOKEN",
          env_var: "PASEO_GITHUB_GIT_TOKEN",
          inject_mode: "basic_auth",
        },
      },
    });
  });
});

describe("prepareSandboxLaunch", () => {
  it("launches the server under nono with a scrubbed environment and private state", async () => {
    const paseoHome = tempDir("paseo-sandbox-home-");
    const bin = tempDir("paseo-sandbox-bin-");
    const executable = path.join(bin, "opencode");
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
    const cwd = tempDir("paseo-sandbox-work-");
    const launch = await prepareSandboxLaunch({
      nono: "/opt/nono",
      agentId: "agent-1",
      cwd,
      paseoHome,
      executable,
      args: ["serve", "--hostname", "127.0.0.1", "--port", "4242"],
      port: 4242,
      routes: [bridgeRoute],
      childEnv: {
        OPENCODE_CONFIG_CONTENT: "{}",
        PASEO_AGENT_ID: "agent-1",
        OPENCODE_PASSWORD: "pw",
      },
      hostEnv: {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/daemon",
        LANG: "en_US.UTF-8",
        GIT_AUTHOR_NAME: "bot",
        GIT_AUTHOR_EMAIL: "bot@example.invalid",
        GITHUB_TOKEN: "host-github-token",
        ANTHROPIC_API_KEY: "host-anthropic-key",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        XDG_RUNTIME_DIR: "/run/user/1000",
        PASEO_BRIDGE_TOKEN: "stale",
      },
    });
    expect(launch.command).toBe("/opt/nono");
    expect(launch.args).toEqual([
      "run",
      "--silent",
      "--no-rollback",
      "--profile",
      path.join(launch.paths.root, "profile.json"),
      "--listen-port",
      "4242",
      "--",
      realpathSync(executable),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4242",
    ]);
    expect(launch.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/daemon",
      LANG: "en_US.UTF-8",
      GIT_AUTHOR_NAME: "bot",
      GIT_AUTHOR_EMAIL: "bot@example.invalid",
      OPENCODE_CONFIG_CONTENT: "{}",
      PASEO_AGENT_ID: "agent-1",
      OPENCODE_PASSWORD: "pw",
      PASEO_SANDBOX_GIT_ROUTES: "[]",
      // nono replaces this with a phantom token in the child (verified by the real e2e).
      PASEO_BRIDGE_TOKEN: "real-bridge-secret",
    });
    const profileFile = path.join(launch.paths.root, "profile.json");
    expect(statSync(profileFile).mode & 0o777).toBe(0o600);
    expect(statSync(launch.paths.data).mode & 0o777).toBe(0o700);
    const profile = JSON.parse(readFileSync(profileFile, "utf8"));
    expect(profile.filesystem.read).toEqual([bin]);
  });

  it("grants a linked worktree's private gitdir and its own ref directory", async () => {
    const root = tempDir("paseo-sandbox-git-");
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    runGit(repo, "init", "-q", "-b", "main");
    runGit(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = path.join(root, "subagent-1");
    runGit(repo, "worktree", "add", "-q", "-b", "paseo-subagents/subagent-1/work", worktree);
    const paseoHome = path.join(root, "home");
    const launch = await prepareSandboxLaunch({
      nono: "/opt/nono",
      agentId: "agent-1",
      cwd: worktree,
      paseoHome,
      executable: "/bin/sh",
      args: [],
      port: 1,
      routes: [],
      childEnv: {},
      hostEnv: {},
    });
    const profile = JSON.parse(readFileSync(path.join(launch.paths.root, "profile.json"), "utf8"));
    const common = path.join(repo, ".git");
    expect(profile.filesystem.read).toContain(common);
    expect(profile.filesystem.allow).toEqual(
      expect.arrayContaining([
        path.join(common, "worktrees", "subagent-1"),
        path.join(common, "objects"),
        path.join(common, "refs", "heads", "paseo-subagents", "subagent-1"),
        path.join(common, "logs", "refs", "heads", "paseo-subagents", "subagent-1"),
      ]),
    );
    expect(profile.filesystem.allow).not.toContain(common);
    expect(
      statSync(
        path.join(common, "logs", "refs", "heads", "paseo-subagents", "subagent-1"),
      ).isDirectory(),
    ).toBe(true);
  });
});

describe("gitHubRoutes", () => {
  it("exposes GitHub git only when the daemon environment holds a token", () => {
    expect(gitHubRoutes({})).toEqual([]);
    expect(gitHubRoutes({ GITHUB_TOKEN: "  " })).toEqual([]);
    expect(gitHubRoutes({ GITHUB_TOKEN: "tok" })).toEqual([
      {
        name: "github_git",
        upstream: "https://github.com",
        envVar: "PASEO_GITHUB_GIT_TOKEN",
        mode: "basic",
        secret: "x-access-token:tok",
        gitRewrite: "https://github.com/",
      },
    ]);
  });
});

describe("isGitLayout", () => {
  it("accepts only layouts git creates, so a rewritten .git pointer cannot widen reads", () => {
    const root = tempDir("paseo-git-layout-");
    const common = path.join(root, ".git");
    mkdirSync(path.join(common, "objects"), { recursive: true });
    mkdirSync(path.join(common, "worktrees", "a"), { recursive: true });
    writeFileSync(path.join(common, "HEAD"), "ref: refs/heads/main\n");
    expect(isGitLayout({ commonDir: common, gitDir: common, branch: null })).toBe(true);
    expect(
      isGitLayout({ commonDir: common, gitDir: path.join(common, "worktrees", "a"), branch: null }),
    ).toBe(true);
    expect(isGitLayout({ commonDir: common, gitDir: "/Users/someone/.ssh", branch: null })).toBe(
      false,
    );
    expect(
      isGitLayout({
        commonDir: "/Users/someone/.ssh",
        gitDir: "/Users/someone/.ssh",
        branch: null,
      }),
    ).toBe(false);
  });
});

describe("hostTempDenyPaths", () => {
  it("denies the daemon user's macOS temp and cache root that nono's system group exposes", () => {
    const temp = realpathSync(tmpdir());
    const root = path.basename(temp) === "T" ? path.dirname(temp) : temp;
    expect(hostTempDenyPaths({ platform: "darwin", tmpdir: tmpdir(), keep: [homedir()] })).toEqual([
      root,
    ]);
  });

  it("never denies a directory the agent must use, and adds nothing on Linux", () => {
    const inside = tempDir("paseo-sandbox-keep-");
    expect(hostTempDenyPaths({ platform: "darwin", tmpdir: tmpdir(), keep: [inside] })).toEqual([]);
    expect(hostTempDenyPaths({ platform: "linux", tmpdir: tmpdir(), keep: [homedir()] })).toEqual(
      [],
    );
  });
});

describe("localPluginDirs", () => {
  it("grants only local plugin packages the server must load", () => {
    expect(
      localPluginDirs(
        JSON.stringify({
          plugins: [
            { package: "file:///paseo/runtime/opencode/paseo-v2-abc", options: {} },
            "file:///other/plugin",
            { package: "npm-plugin" },
            "registry-plugin",
          ],
        }),
      ),
    ).toEqual(["/paseo/runtime/opencode/paseo-v2-abc", "/other/plugin"]);
    expect(localPluginDirs(undefined)).toEqual([]);
    expect(localPluginDirs("{}")).toEqual([]);
  });
});

describe("protectSandboxedCheckouts", () => {
  it("protects every persisted sandboxed checkout, and only those, at daemon start", () => {
    resetSandboxedCheckoutsForTests();
    try {
      protectSandboxedCheckouts([
        { cwd: "/work/sandboxed", isolation: { sandbox: "nono" } },
        { cwd: "/work/opted-out", isolation: { sandbox: "opted-out" } },
        { cwd: "/work/legacy" },
      ]);
      expect(sandboxedGitWrapperFor("/work/sandboxed/src")).not.toBeNull();
      expect(sandboxedGitWrapperFor("/work/opted-out")).toBeNull();
      expect(sandboxedGitWrapperFor("/work/legacy")).toBeNull();
    } finally {
      resetSandboxedCheckoutsForTests();
    }
  });
});
