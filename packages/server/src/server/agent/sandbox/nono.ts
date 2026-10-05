import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import {
  protectSandboxedCheckout,
  type SandboxedGitWrapper,
} from "../../../utils/sandboxed-git.js";

const execFileAsync = promisify(execFile);

// Reviewed release; installer pins and checksums live in docs/subagent-isolation.md.
export const NONO_VERSION = "0.79.0";

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(
      `${message}. Sandboxed subagents require nono ${NONO_VERSION}; install it, or create the agent with isolation.sandbox: false and a reason.`,
    );
    this.name = "SandboxUnavailableError";
  }
}

export async function resolveNono(
  find: (name: string) => Promise<string | null> = findExecutable,
  version: (binary: string) => Promise<string> = readVersion,
): Promise<string> {
  const binary = await find("nono");
  if (!binary) throw new SandboxUnavailableError("nono is not installed on PATH");
  const reported = (await version(binary).catch(() => "")).trim();
  if (reported !== `nono ${NONO_VERSION}`) {
    throw new SandboxUnavailableError(
      `nono at ${binary} reports "${reported || "no version"}", expected nono ${NONO_VERSION}`,
    );
  }
  return binary;
}

async function readVersion(binary: string): Promise<string> {
  const { stdout } = await execFileAsync(binary, ["--version"], { timeout: 10_000 });
  return stdout;
}

export interface GitCheckout {
  /** Directory git reads for this checkout (a linked worktree's private gitdir). */
  gitDir: string;
  /** Shared object database, refs and config. */
  commonDir: string;
  /** Branch checked out in the worktree, or null when detached. */
  branch: string | null;
}

export async function inspectGitCheckout(cwd: string): Promise<GitCheckout | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
        "--abbrev-ref",
        "HEAD",
      ],
      { cwd, timeout: 10_000 },
    );
    const [gitDir, commonDir, head] = stdout.trim().split("\n");
    if (!gitDir || !commonDir) return null;
    return { gitDir, commonDir, branch: head && head !== "HEAD" ? head : null };
  } catch {
    return null;
  }
}

export async function resolveGitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD"],
      { cwd, timeout: 10_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** A credentialed upstream reached through nono's reverse proxy. */
export interface ProxyCredentialRoute {
  /** Route name; nono exports `<NAME>_BASE_URL` to the child. Lowercase, underscores. */
  name: string;
  upstream: string;
  /** Child-visible env var. nono replaces its value with a phantom session token. */
  envVar: string;
  mode: "bearer" | "basic";
  /** Real secret (basic: `user:password`). Passed only to nono, never to the child. */
  secret: string;
  /** Rewrite git remotes with this prefix to the proxied route (git routes only). */
  gitRewrite?: string;
}

export interface SandboxPaths {
  root: string;
  home: string;
  config: string;
  data: string;
  cache: string;
  state: string;
  tmp: string;
}

export function sandboxPaths(paseoHome: string, agentId: string): SandboxPaths {
  const root = path.join(paseoHome, "runtime", "sandbox", agentId);
  return {
    root,
    home: path.join(root, "home"),
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    state: path.join(root, "state"),
    tmp: path.join(root, "tmp"),
  };
}

// Hosts a sandboxed OpenCode server may reach through nono's filtering proxy.
export const SANDBOX_ALLOWED_DOMAINS = [
  "models.dev",
  "models.opencode.ai",
  "api.anthropic.com",
  "api.openai.com",
  "chatgpt.com",
  "registry.npmjs.org",
];

export interface SandboxProfileInput {
  agentId: string;
  cwd: string;
  paths: SandboxPaths;
  /** Directories holding the OpenCode executable and its runtime. */
  executableDirs: string[];
  git: GitCheckout | null;
  routes: ProxyCredentialRoute[];
  /** Host paths nono's default groups would expose read-only; denied outright. */
  denyPaths?: string[];
  platform?: NodeJS.Platform;
}

/**
 * nono's macOS system group grants /private/var read-only, which includes the
 * daemon user's own temporary and cache directories (other agents' files).
 */
export function hostTempDenyPaths(input: {
  platform: NodeJS.Platform;
  tmpdir: string;
  keep: string[];
}): string[] {
  if (input.platform !== "darwin") return [];
  const temp = realpathSync(input.tmpdir);
  const root = path.basename(temp) === "T" ? path.dirname(temp) : temp;
  // Never deny a directory the agent itself must use.
  if (input.keep.some((dir) => hasPathPrefix(dir, root))) return [];
  return [root];
}

export function buildSandboxProfile(input: SandboxProfileInput): Record<string, unknown> {
  const { paths, git } = input;
  const allow = [input.cwd, paths.config, paths.data, paths.cache, paths.state, paths.tmp];
  const read = [...input.executableDirs];
  if (git) {
    // The shared repository stays read-only: its config and hooks run in the
    // orchestrator's unsandboxed git. Only this worktree's gitdir, the object
    // store and this worktree's own branch refs are writable.
    read.push(git.commonDir);
    if (git.gitDir !== git.commonDir) allow.push(git.gitDir);
    allow.push(path.join(git.commonDir, "objects"));
    if (git.branch) {
      allow.push(...branchRefDirs(git.commonDir, git.branch));
    }
  }
  // OpenCode realpaths a linked worktree's main checkout. Bun opens it for data,
  // which Seatbelt denies; a literal grant permits that node only (its file names,
  // never file contents). Landlock does not restrict realpath on Linux.
  const mainCheckout =
    git && path.basename(git.commonDir) === ".git" ? path.dirname(git.commonDir) : null;
  const seatbeltRules =
    (input.platform ?? process.platform) === "darwin" && mainCheckout
      ? [`(allow file-read* (literal "${seatbeltString(mainCheckout)}"))`]
      : [];
  return {
    meta: { name: `paseo-subagent-${input.agentId}` },
    ...(seatbeltRules.length ? { unsafe_macos_seatbelt_rules: seatbeltRules } : {}),
    workdir: { access: "readwrite" },
    security: { signal_mode: "isolated", capability_elevation: false },
    // Pathname AF_UNIX sockets are otherwise reachable on Linux (user service
    // manager, session bus). No socket is granted, so nothing is resumed.
    linux: { af_unix_mediation: "pathname" },
    filesystem: {
      allow: unique(allow),
      read: unique(read),
      ...(input.denyPaths?.length ? { deny: unique(input.denyPaths) } : {}),
    },
    environment: {
      set_vars: {
        HOME: paths.home,
        TMPDIR: paths.tmp,
        XDG_CONFIG_HOME: paths.config,
        XDG_DATA_HOME: paths.data,
        XDG_CACHE_HOME: paths.cache,
        XDG_STATE_HOME: paths.state,
        // OpenCode's project-config discovery realpaths every ancestor, which
        // Seatbelt denies outside the grants (nono's own OpenCode profile sets this).
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        // Reverse-proxy routes live on loopback; never send them to the forward proxy.
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
    network: {
      allow_domain: SANDBOX_ALLOWED_DOMAINS,
      credentials: input.routes.map((route) => route.name),
      custom_credentials: Object.fromEntries(
        input.routes.map((route) => [route.name, credential(route)]),
      ),
    },
  };
}

// nono reads the secret from the variable it then overwrites with a phantom
// token in the child. A separate source variable would be inherited verbatim.
function credential(route: ProxyCredentialRoute): Record<string, string> {
  const base = {
    upstream: route.upstream,
    credential_key: `env://${route.envVar}`,
    env_var: route.envVar,
  };
  return route.mode === "basic"
    ? { ...base, inject_mode: "basic_auth" }
    : { ...base, inject_header: "Authorization", credential_format: "Bearer {}" };
}

function branchRefDirs(commonDir: string, branch: string): string[] {
  const dir = path.posix.dirname(branch);
  const scope = dir === "." ? null : dir;
  // A branch without a directory component would need all of refs/heads.
  if (!scope) return [];
  return [
    path.join(commonDir, "refs", "heads", scope),
    path.join(commonDir, "logs", "refs", "heads", scope),
  ];
}

function seatbeltString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export interface SandboxLaunch {
  command: string;
  args: string[];
  /** Complete environment for nono; never merged with the daemon's environment. */
  env: Record<string, string>;
  paths: SandboxPaths;
}

const PASSTHROUGH_ENV = ["PATH", "USER", "LOGNAME", "LANG", "TERM", "TZ", "SHELL"];

export async function prepareSandboxLaunch(input: {
  nono: string;
  agentId: string;
  cwd: string;
  paseoHome: string;
  executable: string;
  args: string[];
  port: number;
  routes: ProxyCredentialRoute[];
  /** Read-only directories the server needs, such as Paseo's materialized plugin. */
  readPaths?: string[];
  /** Child environment (OpenCode config, agent identity, server password). */
  childEnv: Record<string, string>;
  hostEnv?: NodeJS.ProcessEnv;
}): Promise<SandboxLaunch> {
  const hostEnv = input.hostEnv ?? process.env;
  const paths = sandboxPaths(input.paseoHome, input.agentId);
  for (const dir of [paths.home, paths.config, paths.data, paths.cache, paths.state, paths.tmp]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const git = await inspectGitCheckout(input.cwd);
  if (git?.branch) {
    for (const dir of branchRefDirs(git.commonDir, git.branch)) {
      await mkdir(dir, { recursive: true });
    }
  }
  const executable = realpathSync(input.executable);
  const profile = buildSandboxProfile({
    agentId: input.agentId,
    cwd: input.cwd,
    paths,
    executableDirs: [path.dirname(executable), ...(input.readPaths ?? [])],
    git,
    routes: input.routes,
    denyPaths: hostTempDenyPaths({
      platform: process.platform,
      tmpdir: os.tmpdir(),
      keep: [realpathSync(input.cwd), realpathSync(paths.root), path.dirname(executable)],
    }),
  });
  const profilePath = path.join(paths.root, "profile.json");
  await writeFile(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });

  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = hostEnv[key];
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(hostEnv)) {
    if (key.startsWith("LC_") && value) env[key] = value;
  }
  // nono keeps its own state under the daemon user's real HOME/XDG; the
  // profile's set_vars give the child its private directories.
  for (const key of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
  ]) {
    const value = hostEnv[key];
    if (value) env[key] = value;
  }
  Object.assign(env, input.childEnv);
  env[SANDBOX_GIT_ROUTES_ENV] = describeGitRoutes(input.routes);
  for (const route of input.routes) env[route.envVar] = route.secret;
  return {
    command: input.nono,
    args: [
      "run",
      "--silent",
      "--no-rollback",
      "--profile",
      profilePath,
      "--listen-port",
      String(input.port),
      "--",
      executable,
      ...input.args,
    ],
    env,
    paths,
  };
}

export function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address !== "string") resolve(address.port);
        else reject(new Error("Could not reserve a loopback port"));
      });
    });
  });
}

/**
 * GitHub HTTPS git through nono's proxy, from nono's own GITHUB_TOKEN convention
 * in the daemon environment. Absent token, sandboxed agents cannot push to GitHub.
 */
export function gitHubRoutes(hostEnv: NodeJS.ProcessEnv = process.env): ProxyCredentialRoute[] {
  const token = hostEnv.GITHUB_TOKEN?.trim();
  if (!token) return [];
  return [
    {
      name: "github_git",
      upstream: "https://github.com",
      envVar: "PASEO_GITHUB_GIT_TOKEN",
      mode: "basic",
      secret: `x-access-token:${token}`,
      gitRewrite: "https://github.com/",
    },
  ];
}

/** Non-secret description the in-sandbox bridge plugin uses to configure git. */
export const SANDBOX_GIT_ROUTES_ENV = "PASEO_SANDBOX_GIT_ROUTES";

export function describeGitRoutes(routes: ProxyCredentialRoute[]): string {
  return JSON.stringify(
    routes
      .filter((route) => route.gitRewrite)
      .map((route) => ({
        baseUrlEnv: `${route.name.toUpperCase()}_BASE_URL`,
        tokenEnv: route.envVar,
        rewrite: route.gitRewrite,
      })),
  );
}

/** Daemon git inside a sandboxed checkout: pinned nono, the real git binary, read-only. */
export async function resolveSandboxedGitWrapper(
  root: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Promise<SandboxedGitWrapper> {
  const nono = await resolveNono();
  const git = await resolveGitBinary();
  // The checkout's `.git` pointer is agent-writable; only trust a layout git creates.
  const checkout = await inspectGitCheckout(root);
  const trusted = checkout && isGitLayout(checkout) ? checkout : null;
  const home = hostEnv.HOME ?? "";
  const xdgConfig = hostEnv.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return {
    nono,
    git,
    readPaths: existingPaths(trusted ? [...new Set([trusted.commonDir, trusted.gitDir])] : []),
    readFiles: existingPaths([
      path.join(home, ".gitconfig"),
      path.join(xdgConfig, "git", "config"),
    ]),
  };
}

export function isGitLayout(checkout: GitCheckout): boolean {
  const { commonDir, gitDir } = checkout;
  if (!existsSync(path.join(commonDir, "HEAD")) || !existsSync(path.join(commonDir, "objects"))) {
    return false;
  }
  return gitDir === commonDir || path.dirname(gitDir) === path.join(commonDir, "worktrees");
}

// macOS /usr/bin/git is an xcrun shim that probes developer directories the
// sandbox does not grant; run the toolchain binary it resolves to instead.
async function resolveGitBinary(): Promise<string> {
  if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("xcrun", ["-f", "git"], { timeout: 10_000 }).catch(
      () => ({ stdout: "" }),
    );
    if (stdout.trim()) return realpathSync(stdout.trim());
  }
  const git = await findExecutable("git");
  if (!git) throw new SandboxUnavailableError("git is not installed on PATH");
  return realpathSync(git);
}

export function protectCheckoutForSandboxedAgent(root: string): void {
  protectSandboxedCheckout(root, () => resolveSandboxedGitWrapper(root));
}

/** Persisted sandboxed agents' checkouts, protected before any daemon git runs. */
export function protectSandboxedCheckouts(
  records: Array<{ cwd: string; isolation?: { sandbox: string } }>,
): void {
  for (const record of records) {
    if (record.isolation?.sandbox === "nono") protectCheckoutForSandboxedAgent(record.cwd);
  }
}

/** Local plugin packages named in an OpenCode V2 config; the server must read them. */
export function localPluginDirs(configContent: string | undefined): string[] {
  if (!configContent) return [];
  const config = JSON.parse(configContent) as { plugins?: unknown };
  if (!Array.isArray(config.plugins)) return [];
  const dirs: string[] = [];
  for (const plugin of config.plugins) {
    const reference = pluginReference(plugin);
    if (reference.startsWith("file:")) dirs.push(fileURLToPath(reference));
  }
  return dirs;
}

function pluginReference(plugin: unknown): string {
  if (typeof plugin === "string") return plugin;
  if (plugin && typeof plugin === "object" && "package" in plugin) {
    return String((plugin as { package: unknown }).package);
  }
  return "";
}

export function hasPathPrefix(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function existingPaths(paths: string[]): string[] {
  return paths.filter((candidate) => existsSync(candidate));
}
