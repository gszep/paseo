// Real nono + real OpenCode: Paseo's sandboxed runtime confines the whole
// OpenCode server process tree. Every command runs through OpenCode's own shell
// API, the same process tree that runs an agent's tools. Throwaway directories
// only; credentials are synthetic. Run explicitly on macOS and Linux:
//   npx vitest run src/server/agent/providers/opencode/v2/sandbox.local.e2e.test.ts
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { findExecutable } from "../../../../../executable-resolution/executable-resolution.js";
import { runGitCommand } from "../../../../../utils/run-git-command.js";
import { resolveNono, type ProxyCredentialRoute } from "../../../sandbox/nono.js";
import { OpenCodeBridge } from "../bridge.js";
import { V2Runtime, type V2Connection } from "./runtime.js";

const nono = await resolveNono().catch(() => null);
const opencode = await findExecutable("opencode");
const SYNTHETIC_GIT_CREDENTIAL = `paseo:synthetic-${Math.random().toString(36).slice(2)}`;

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "fixture",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "fixture@example.invalid",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "fixture",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "fixture@example.invalid",
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv }).toString().trim();
}

/** Smart-HTTP git upstream that accepts only the synthetic Basic credential. */
function gitUpstream(projectRoot: string, seen: string[]): Server {
  const expected = `Basic ${Buffer.from(SYNTHETIC_GIT_CREDENTIAL).toString("base64")}`;
  return createServer(async (request, response) => {
    const auth = request.headers.authorization;
    if (auth === expected) seen.push("synthetic");
    else seen.push(auth ? "other" : "none");
    if (auth !== expected) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const [pathInfo, query = ""] = (request.url ?? "/").split("?");
    const result = spawnSync("git", ["http-backend"], {
      input: Buffer.concat(chunks),
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "paseo",
        PATH_INFO: pathInfo,
        QUERY_STRING: query,
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(Buffer.concat(chunks).length),
        ...(request.headers["content-encoding"]
          ? { HTTP_CONTENT_ENCODING: String(request.headers["content-encoding"]) }
          : {}),
      },
    });
    const output = result.stdout;
    const split = output.indexOf("\r\n\r\n");
    const head = output.subarray(0, split).toString();
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split("\r\n")) {
      const [name, ...rest] = line.split(":");
      if (!name) continue;
      if (name.toLowerCase() === "status") status = Number(rest.join(":").trim().split(" ")[0]);
      else headers[name] = rest.join(":").trim();
    }
    response.writeHead(status, headers);
    response.end(output.subarray(split + 4));
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function sh(connection: V2Connection, cwd: string, command: string): Promise<string> {
  const location = { directory: cwd };
  const created = await connection.client.shell.create({ location, command, cwd, timeout: 60_000 });
  const id = created.data.id;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const current = await connection.client.shell.get({ id, location });
    if (current.data.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const output = await connection.client.shell.output({ id, location });
  return (output.data as { output: string }).output;
}

describe.skipIf(!nono || !opencode)("nono-sandboxed OpenCode server (real)", () => {
  const logger = createTestLogger();
  // macOS: nono denies the daemon's own temp root, so fixtures live under HOME.
  const root = realpathSync(
    mkdtempSync(
      path.join(process.env.PASEO_SANDBOX_E2E_ROOT ?? os.homedir(), ".paseo-sandbox-e2e-"),
    ),
  );
  const paseoHome = path.join(root, "paseo-home");
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "subagent-e2e");
  const outside = path.join(root, "outside");
  const remote = path.join(root, "remote");
  const upstreamSeen: string[] = [];
  const previousPaseoHome = process.env.PASEO_HOME;
  let upstream: Server;
  let daemonStandIn: Server;
  let daemonPort = 0;
  let bridge: OpenCodeBridge;
  let runtime: V2Runtime;
  let sandboxed: V2Connection;
  let orchestrator: V2Connection;

  beforeAll(async () => {
    process.env.PASEO_HOME = paseoHome;
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "sentinel"), "original\n");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "README.md"), "fixture\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "test: fixture");
    git(repo, "worktree", "add", "-q", "-b", "paseo-subagents/subagent-e2e/work", worktree);
    git(root, "init", "-q", "--bare", "-b", "main", path.join(remote, "repo.git"));
    git(path.join(remote, "repo.git"), "config", "http.receivepack", "true");

    upstream = gitUpstream(remote, upstreamSeen);
    const upstreamPort = await listen(upstream);
    daemonStandIn = createServer((_request, response) => response.end("daemon"));
    daemonPort = await listen(daemonStandIn);

    bridge = new OpenCodeBridge({ paseoHome, logger });
    await bridge.start();
    bridge.bindSession({ sessionId: "other-agent-session", env: {}, agentId: "other-agent" });
    const route: ProxyCredentialRoute = {
      name: "fixture_git",
      upstream: `http://127.0.0.1:${upstreamPort}`,
      envVar: "PASEO_FIXTURE_GIT_TOKEN",
      mode: "basic",
      secret: SYNTHETIC_GIT_CREDENTIAL,
      gitRewrite: "http://git.fixture.invalid/",
    };
    runtime = new V2Runtime({ logger, sandboxBridge: bridge, gitRoutes: () => [route] });
    sandboxed = await runtime.acquire({
      env: { PASEO_AGENT_ID: "agent-e2e" },
      sandbox: { agentId: "agent-e2e", cwd: worktree },
    });
    orchestrator = await runtime.acquire({ dedicated: true });
  }, 180_000);

  afterAll(async () => {
    await sandboxed?.release();
    await orchestrator?.release();
    await runtime?.shutdown();
    await bridge?.close();
    upstream?.close();
    daemonStandIn?.close();
    if (previousPaseoHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousPaseoHome;
    if (!process.env.PASEO_SANDBOX_E2E_KEEP) rmSync(root, { recursive: true, force: true });
  });

  test("the sandboxed connection is the agent's own confined server", () => {
    expect(sandboxed.sandboxAgentId).toBe("agent-e2e");
    expect(orchestrator.sandboxAgentId).toBeNull();
  });

  test("the agent works and commits inside its worktree", async () => {
    const output = await sh(
      sandboxed,
      worktree,
      `echo change > change.txt && git add change.txt && git commit -q -m "test: sandboxed commit" && echo commit_exit=$?`,
    );
    expect(output).toContain("commit_exit=0");
    expect(git(worktree, "log", "-1", "--format=%s")).toBe("test: sandboxed commit");
  });

  test("writes outside the worktree are refused", async () => {
    const sentinel = path.join(outside, "sentinel");
    const output = await sh(
      sandboxed,
      worktree,
      `echo changed > '${sentinel}' 2>/dev/null && echo outside=written || echo outside=refused; ` +
        `echo x > '${path.join(repo, "planted.txt")}' 2>/dev/null && echo source=written || echo source=refused; ` +
        `echo x > '${path.join(repo, ".git", "hooks", "post-checkout")}' 2>/dev/null && echo hook=written || echo hook=refused; ` +
        `echo x > '${path.join(repo, ".git", "refs", "heads", "main")}' 2>/dev/null && echo main_ref=written || echo main_ref=refused`,
    );
    expect(output).toContain("outside=refused");
    expect(output).toContain("source=refused");
    expect(output).toContain("hook=refused");
    expect(output).toContain("main_ref=refused");
    expect(readFileSync(sentinel, "utf8")).toBe("original\n");
    expect(existsSync(path.join(repo, "planted.txt"))).toBe(false);
  });

  test("host credential stores are unreadable (no bytes are read)", async () => {
    const home = os.homedir();
    const candidates = [
      path.join(home, ".config", "gh", "hosts.yml"),
      path.join(home, ".ssh"),
      path.join(home, "Library", "Keychains", "login.keychain-db"),
      path.join(home, ".gitconfig"),
    ].filter((candidate) => existsSync(candidate));
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      // `head -c 0` opens a file without reading; `ls` lists a directory's names only.
      const open = candidate.endsWith(".ssh")
        ? `ls '${candidate}' >/dev/null`
        : `head -c 0 '${candidate}'`;
      const probe = `${open} 2>/dev/null && echo readable || echo denied`;
      expect(await sh(sandboxed, worktree, probe), candidate).toContain("denied");
    }
  });

  test("the daemon and other agents are unreachable; the bridge credential is a phantom", async () => {
    const output = await sh(
      sandboxed,
      worktree,
      `curl --noproxy '*' -s -m 3 -o /dev/null http://127.0.0.1:${daemonPort}/ && echo daemon=reached || echo daemon=refused; ` +
        `echo manifest=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $PASEO_BRIDGE_TOKEN" "$PASEO_BRIDGE_BASE_URL/_internal/opencode/tools"); ` +
        `echo other_session=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $PASEO_BRIDGE_TOKEN" "$PASEO_BRIDGE_BASE_URL/_internal/opencode/sessions/other-agent-session/context")`,
    );
    expect(output).toContain("daemon=refused");
    expect(output).toContain("manifest=200");
    expect(output).toContain("other_session=404");
  });

  test("the user service manager and session bus are unreachable on Linux", async () => {
    if (process.platform !== "linux" || !(await findExecutable("systemd-run"))) return;
    const sentinel = path.join(outside, "via-bus");
    const output = await sh(
      sandboxed,
      worktree,
      `XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus ` +
        `systemd-run --user --quiet --wait --collect /bin/sh -c 'echo escaped > ${sentinel}' >/dev/null 2>&1 ` +
        `&& echo user_bus=reached || echo user_bus=refused`,
    );
    expect(output).toContain("user_bus=refused");
    expect(existsSync(sentinel)).toBe(false);
  });

  test("git push works through nono's credential proxy without exposing the credential", async () => {
    const secret = SYNTHETIC_GIT_CREDENTIAL.split(":")[1]!;
    const output = await sh(
      sandboxed,
      worktree,
      `env | grep -c '${secret}' ; git push -q http://git.fixture.invalid/repo.git HEAD:refs/heads/proxied 2>&1; echo push_exit=$?`,
    );
    expect(output.split("\n")[0]?.trim()).toBe("0");
    expect(output).toContain("push_exit=0");
    expect(upstreamSeen).toContain("synthetic");
    expect(upstreamSeen).not.toContain("other");
    expect(git(path.join(remote, "repo.git"), "log", "-1", "--format=%s", "proxied")).toBe(
      "test: sandboxed commit",
    );
  });

  test("daemon git in the sandboxed checkout cannot run the agent's repository config", async () => {
    // The agent plants a nested repository whose config runs a command on `git diff`.
    const nested = path.join(worktree, "nested");
    const pwned = path.join(outside, "pwned-by-diff-external");
    await sh(
      sandboxed,
      worktree,
      `mkdir -p nested && cd nested && git init -q && echo a > f && git add f && ` +
        `git -c user.name=x -c user.email=x@x commit -q -m init && echo b > f && ` +
        `printf '#!/bin/sh\\necho escaped > ${pwned}\\n' > hostile.sh && chmod +x hostile.sh && ` +
        `git config diff.external "$PWD/hostile.sh" && echo planted`,
    );
    // Proof the attack is real: unprotected git runs it.
    const copy = path.join(root, "nested-copy");
    execFileSync("cp", ["-R", nested, copy]);
    const copyPwned = path.join(outside, "pwned-by-copy");
    execFileSync("git", ["config", "diff.external", path.join(copy, "copy-hostile.sh")], {
      cwd: copy,
    });
    writeFileSync(path.join(copy, "copy-hostile.sh"), `#!/bin/sh\necho escaped > ${copyPwned}\n`, {
      mode: 0o755,
    });
    execFileSync("git", ["diff"], { cwd: copy, env: gitEnv });
    expect(existsSync(copyPwned)).toBe(true);

    // The daemon's git in the agent's checkout runs read-only under nono.
    await runGitCommand(["diff"], { cwd: nested, acceptExitCodes: [0, 1, 128] }).catch(() => null);
    expect(existsSync(pwned)).toBe(false);
  });

  test("the orchestrator's server is not sandboxed", async () => {
    const sentinel = path.join(outside, "orchestrator-write");
    const output = await sh(
      orchestrator,
      root,
      `echo ok > '${sentinel}' && echo orchestrator_write=ok`,
    );
    expect(output).toContain("orchestrator_write=ok");
    expect(readFileSync(sentinel, "utf8")).toBe("ok\n");
  });
});
