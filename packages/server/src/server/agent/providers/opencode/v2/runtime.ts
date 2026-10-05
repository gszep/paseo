import {
  decorateOpenCodeV2Env,
  materializeOpenCodeV2Plugin,
  SANDBOX_BRIDGE_ROUTE,
  SANDBOX_BRIDGE_TOKEN_ENV,
  type OpenCodeBridge,
} from "../bridge.js";
import type { AgentSandboxRequest } from "../../../agent-sdk-types.js";
import { findExecutable } from "../../../../../executable-resolution/executable-resolution.js";
import {
  gitHubRoutes,
  localPluginDirs,
  prepareSandboxLaunch,
  protectCheckoutForSandboxedAgent,
  reservePort,
  resolveNono,
  SandboxUnavailableError,
  type ProxyCredentialRoute,
} from "../../../sandbox/nono.js";
import { resolvePaseoHome } from "../../../../paseo-home.js";
import { OpenCode } from "@opencode/client";
import type { V2Api } from "./api.js";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Logger } from "pino";
import { spawnProcess } from "../../../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../../../utils/tree-kill.js";
import {
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
  type ResolvedProviderLaunch,
} from "../../../provider-launch-config.js";
import type { ManagedProcessRegistry } from "../../../../managed-processes/managed-processes.js";
import { resolveOpenCodeHomeDir } from "../paths.js";
import { OpenCodeHttpError } from "../http-error.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";
import { httpRuntime } from "@henkaku-center/chi-native/runtime-http";
import { boundedText } from "@henkaku-center/chi-native/http";
import type { NativeRuntime } from "@henkaku-center/chi-native/continuation";

export interface V2Connection {
  client: V2Api;
  transfer?: NativeRuntime;
  release(): Promise<void>;
  retain(): V2Connection;
  readonly exited: Promise<Error>;
  /** Agent whose nono-confined server this is; null for an unsandboxed server. */
  readonly sandboxAgentId: string | null;
}
interface Generation {
  client: V2Api;
  transfer: NativeRuntime;
  users: number;
  stop(): Promise<void>;
  exited: Promise<Error>;
  sandboxAgentId: string | null;
}
export type SandboxBridge = Pick<
  OpenCodeBridge,
  "issueScopedAccess" | "decorateSandboxedV2ServerEnv"
>;
interface V2RuntimeOptions {
  logger: Logger;
  settings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  decorateEnv?: (env: Record<string, string>) => Record<string, string>;
  sandboxBridge?: SandboxBridge;
  resolveNonoBinary?: () => Promise<string>;
  /** Credentialed git upstreams reached through nono's proxy; defaults to GitHub. */
  gitRoutes?: () => ProxyCredentialRoute[];
}
interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  /** Direct launches overlay the daemon env; sandboxed launches replace it. */
  env:
    | { kind: "overlay"; overlay: Record<string, string> }
    | { kind: "replace"; env: Record<string, string> };
  cleanup(): void;
}

// The runtime owns a credential for each subprocess; sessions only receive its authenticated client.
export class V2Runtime {
  private current: Promise<Generation> | null = null;
  private generations = new Set<Generation>();
  private starts = new Set<Promise<Generation>>();
  private closed = false;

  constructor(private readonly options: V2RuntimeOptions) {}

  async acquire(
    input: {
      fresh?: boolean;
      dedicated?: boolean;
      env?: Record<string, string>;
      sandbox?: AgentSandboxRequest;
      signal?: AbortSignal;
    } = {},
  ): Promise<V2Connection> {
    if (this.closed) throw new Error("OpenCode runtime is closed");
    input.signal?.throwIfAborted();
    let pending: Promise<Generation>;
    if (input.sandbox) {
      pending = this.startTracked(input.env, input.sandbox);
    } else if (input.env || input.dedicated) {
      pending = this.startTracked(input.env);
    } else {
      if (input.fresh || !this.current) this.current = this.startTracked();
      pending = this.current;
    }
    let generation: Generation;
    try {
      generation = await raceProviderRefreshAbort(input.signal, pending);
    } catch (error) {
      if (this.current === pending) this.current = null;
      if (input.signal?.aborted) {
        void pending
          .then(async (started) => {
            if (started.users !== 0) return undefined;
            this.generations.delete(started);
            await started.stop();
            return undefined;
          })
          .catch((cleanupError: unknown) => {
            this.options.logger.warn(
              { error: String(cleanupError) },
              "OpenCode canceled startup cleanup failed",
            );
          });
      }
      throw error;
    }
    if (!this.generations.has(generation)) {
      if (this.current === pending) this.current = null;
      throw new Error("OpenCode helper server exited");
    }
    const connection = this.lease(generation, pending);
    if (input.signal?.aborted || this.closed) {
      await connection.release();
      input.signal?.throwIfAborted();
      throw new Error("OpenCode runtime is closed");
    }
    return connection;
  }

  private lease(generation: Generation, pending: Promise<Generation>): V2Connection {
    if (this.closed || !this.generations.has(generation))
      throw new Error("OpenCode helper server is no longer running");
    generation.users += 1;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      generation.users -= 1;
      if (generation.users !== 0) return;
      if (this.current === pending) this.current = null;
      this.generations.delete(generation);
      await generation.stop();
    };
    return {
      client: generation.client,
      transfer: generation.transfer,
      release,
      retain: () => this.lease(generation, pending),
      exited: generation.exited,
      sandboxAgentId: generation.sandboxAgentId,
    };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.starts);
    await Promise.all([...this.generations].map((generation) => generation.stop()));
    this.generations.clear();
    this.current = null;
  }

  private startTracked(
    env?: Record<string, string>,
    sandbox?: AgentSandboxRequest,
  ): Promise<Generation> {
    const pending = this.start(env, sandbox);
    this.starts.add(pending);
    void pending.then(
      () => this.starts.delete(pending),
      () => this.starts.delete(pending),
    );
    return pending;
  }

  private async start(
    env: Record<string, string> = {},
    sandbox?: AgentSandboxRequest,
  ): Promise<Generation> {
    const { settings, managedProcesses, logger } = this.options;
    const launch = await resolveProviderLaunch({
      commandConfig: settings?.command,
      defaultBinary: "opencode",
    });
    const password = randomBytes(32).toString("base64url");
    const inheritedConfig = globalThis.process.env.OPENCODE_CONFIG_CONTENT;
    const configured = {
      ...(inheritedConfig ? { OPENCODE_CONFIG_CONTENT: inheritedConfig } : {}),
      ...settings?.env,
      ...env,
    };
    const plan = sandbox
      ? await this.planSandboxLaunch({ launch, configured, password, sandbox })
      : await this.planDirectLaunch({ launch, configured, password });
    const { command, args } = plan;
    const process = spawnProcess(command, args, {
      cwd: plan.cwd,
      detached: globalThis.process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      ...(plan.env.kind === "replace"
        ? { baseEnv: plan.env.env, envOverlay: {} }
        : createProviderEnvSpec({ runtimeSettings: settings, overlays: [plan.env.overlay] })),
    });
    if (sandbox) {
      logger.info(
        { agentId: sandbox.agentId, cwd: sandbox.cwd, pid: process.pid },
        "Sandboxed OpenCode server started under nono",
      );
    }
    const processAbort = new AbortController();
    const exited = new Promise<Error>((resolve) =>
      process.once("exit", (code) => {
        const error = new Error(`OpenCode helper server exited (${code})`);
        processAbort.abort(error);
        resolve(error);
      }),
    );
    let stopped: Promise<void> | undefined;
    const record =
      process.pid && managedProcesses
        ? managedProcesses
            .record({
              owner: { provider: "opencode", kind: "helper-server" },
              pid: process.pid,
              command,
              args,
            })
            .catch((error: unknown) => {
              logger.warn({ error }, "Could not record OpenCode helper process");
              return null;
            })
        : Promise.resolve(null);
    const stop = () => {
      stopped ??= (async () => {
        plan.cleanup();
        await terminateWithTreeKill(process, { gracefulTimeoutMs: 5_000, forceTimeoutMs: 1_000 });
        const entry = await record;
        if (entry) await managedProcesses?.remove(entry.id);
      })();
      return stopped;
    };
    const deadline = Date.now() + 30_000;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("OpenCode v2 server startup timed out after 30s")),
          30_000,
        );
        let buffer = "";
        const finish = (result: string | Error) => {
          clearTimeout(timer);
          process.stdout?.off("data", onData);
          process.off("error", onError);
          process.off("exit", onExit);
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const onData = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString()).slice(-8192);
          const match = buffer.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)(?:\r?\n)/);
          if (match) finish(match[1]);
        };
        // Drain stderr without retaining provider output that may contain credentials.
        // A sandboxed launch keeps a bounded prefix: nono reports refusals there
        // before OpenCode starts and before any provider traffic exists.
        let startupStderr = "";
        const onStderr = (chunk: Buffer) => {
          if (sandbox) startupStderr = (startupStderr + chunk.toString()).slice(0, 2048);
        };
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null) =>
          finish(
            new Error(
              `OpenCode v2 server exited during startup (${code})${
                startupStderr.trim() ? `: ${startupStderr.trim()}` : ""
              }`,
            ),
          );
        process.stdout?.on("data", onData);
        process.once("error", onError);
        process.once("exit", onExit);
        process.stderr?.on("data", onStderr);
        void exited.then(() => process.stderr?.off("data", onStderr));
      });
      const client = OpenCode.make({
        baseUrl: url,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
        fetch: async (request, init) => {
          const requestUrl = request instanceof Request ? request.url : String(request);
          const nativeTransfer =
            /^\/api\/experimental\/session\/(?:import|[^/]+\/export)$|^\/api\/session\/[^/]+\/fork$/.test(
              new URL(requestUrl).pathname,
            );
          const signal = init?.signal
            ? AbortSignal.any([init.signal, processAbort.signal])
            : processAbort.signal;
          const response = await fetch(request, {
            ...init,
            signal: nativeTransfer ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : signal,
            ...(nativeTransfer ? { redirect: "error" as const } : {}),
          });
          const html = response.headers.get("content-type")?.includes("text/html") ?? false;
          if (!response.ok || html) {
            await response.body?.cancel();
            throw new OpenCodeHttpError(new URL(requestUrl).pathname, response.status, html);
          }
          if (nativeTransfer)
            return new Response(await boundedText(response, 16 * 1024 * 1024), {
              status: response.status,
              headers: { "content-type": "application/json" },
            });
          return response;
        },
      });
      await client.server.info({ signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      // The transfer adapter shares this owner's credential and never exposes it
      // to the daemon protocol, Chi, or another process.
      const boundedTransfer = httpRuntime(url, password);
      const transfer: NativeRuntime = {
        identity: boundedTransfer.identity,
        schema: boundedTransfer.schema,
        info: () => client.server.info(),
        get: boundedTransfer.get,
        export: (sessionId) => client.session.export({ sessionID: sessionId }),
        import: (data, directory) =>
          client.session.import({ ...data, location: { directory } } as Parameters<
            typeof client.session.import
          >[0]),
        fork: (sessionId) => client.session.fork({ sessionID: sessionId }),
      };
      const generation: Generation = {
        client,
        transfer,
        users: 0,
        stop,
        exited,
        sandboxAgentId: sandbox?.agentId ?? null,
      };
      this.generations.add(generation);
      process.once("exit", () => {
        this.generations.delete(generation);
        void stop().catch((error: unknown) =>
          logger.warn({ error }, "OpenCode process cleanup failed"),
        );
      });
      return generation;
    } catch (error) {
      await stop();
      throw error;
    }
  }

  private async planDirectLaunch(input: {
    launch: ResolvedProviderLaunch;
    configured: Record<string, string>;
    password: string;
  }): Promise<LaunchPlan> {
    const cwd = resolveOpenCodeHomeDir();
    await mkdir(cwd, { recursive: true });
    const decorated = this.options.decorateEnv
      ? this.options.decorateEnv(input.configured)
      : decorateOpenCodeV2Env(
          input.configured,
          await materializeOpenCodeV2Plugin(resolvePaseoHome()),
        );
    return {
      command: input.launch.command,
      args: [...input.launch.args, "serve", "--hostname", "127.0.0.1", "--port", "0"],
      cwd,
      env: { kind: "overlay", overlay: { ...decorated, OPENCODE_PASSWORD: input.password } },
      cleanup: () => undefined,
    };
  }

  // The whole server process tree runs under nono: the agent's shells, tools and
  // plugins inherit the confinement. Only the explicit environment crosses over.
  private async planSandboxLaunch(input: {
    launch: ResolvedProviderLaunch;
    configured: Record<string, string>;
    password: string;
    sandbox: AgentSandboxRequest;
  }): Promise<LaunchPlan> {
    const nono = await (this.options.resolveNonoBinary ?? resolveNono)();
    const executable = await findExecutable(input.launch.command);
    if (!executable) {
      throw new SandboxUnavailableError(
        `OpenCode executable ${input.launch.command} was not found`,
      );
    }
    const bridge = this.options.sandboxBridge;
    const access = bridge?.issueScopedAccess(input.sandbox.agentId) ?? null;
    try {
      const decorated = bridge
        ? bridge.decorateSandboxedV2ServerEnv(input.configured)
        : decorateOpenCodeV2Env(
            input.configured,
            await materializeOpenCodeV2Plugin(resolvePaseoHome()),
          );
      const routes: ProxyCredentialRoute[] = [...(this.options.gitRoutes ?? gitHubRoutes)()];
      if (access) {
        routes.push({
          name: SANDBOX_BRIDGE_ROUTE,
          upstream: access.upstream,
          envVar: SANDBOX_BRIDGE_TOKEN_ENV,
          mode: "bearer",
          secret: access.token,
        });
      }
      const port = await reservePort();
      protectCheckoutForSandboxedAgent(input.sandbox.cwd);
      const prepared = await prepareSandboxLaunch({
        nono,
        agentId: input.sandbox.agentId,
        cwd: input.sandbox.cwd,
        paseoHome: resolvePaseoHome(),
        executable,
        args: [...input.launch.args, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        port,
        routes,
        readPaths: localPluginDirs(decorated.OPENCODE_CONFIG_CONTENT),
        childEnv: {
          ...this.options.settings?.env,
          ...decorated,
          OPENCODE_PASSWORD: input.password,
        },
      });
      return {
        command: prepared.command,
        args: prepared.args,
        cwd: input.sandbox.cwd,
        env: { kind: "replace", env: prepared.env },
        cleanup: () => access?.revoke(),
      };
    } catch (error) {
      access?.revoke();
      throw error;
    }
  }
}
