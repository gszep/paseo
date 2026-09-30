import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getE2EDaemonPort } from "./daemon-port";
import { createNodeWebSocketFactory, type NodeWebSocketFactory } from "./node-ws-factory";

export async function loadDaemonClientConstructor<ClientConfig, ClientInstance>(): Promise<
  new (config: ClientConfig) => ClientInstance
> {
  const repoRoot = path.resolve(__dirname, "../../../../../");
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, "packages/client/dist/daemon-client.js"),
  ).href;
  console.log("DEBUG_RESOLVE_RELAY", import.meta.resolve("@getpaseo/relay/e2ee"));
  console.log("DEBUG_RESOLVE_CLIENT", import.meta.resolve("@getpaseo/client"));
  let mod;
  try {
    mod = (await import(moduleUrl)) as {
      DaemonClient: new (config: ClientConfig) => ClientInstance;
    };
  } catch (error) {
    console.log("DEBUG_IMPORT_ERR", (error as Error).message);
    const relay = await import("@getpaseo/relay/e2ee").catch((e) => ({ err: String(e) }));
    console.log("DEBUG_RELAY_KEYS", Object.keys(relay));
    throw error;
  }
  return mod.DaemonClient;
}

interface E2EDaemonClientConfig {
  url: string;
  clientId: string;
  clientType: "cli";
  appVersion?: string;
  webSocketFactory?: NodeWebSocketFactory;
}

function resolveDaemonWsUrl(port?: number): string {
  return `ws://127.0.0.1:${port ?? getE2EDaemonPort()}/ws`;
}

export interface ConnectDaemonClientOptions {
  clientIdPrefix: string;
  appVersion?: string;
  port?: number;
}

/**
 * Connects an in-test daemon client over the isolated E2E daemon's WebSocket.
 * The port-6767 guard keeps tests off the developer daemon. Each helper passes
 * its own typed client interface as the generic.
 */
export async function connectDaemonClient<ClientInstance extends { connect(): Promise<void> }>(
  options: ConnectDaemonClientOptions,
): Promise<ClientInstance> {
  const DaemonClient = await loadDaemonClientConstructor<E2EDaemonClientConfig, ClientInstance>();
  const client = new DaemonClient({
    url: resolveDaemonWsUrl(options.port),
    clientId: `${options.clientIdPrefix}-${randomUUID()}`,
    clientType: "cli",
    appVersion: options.appVersion ?? loadAppVersion(),
    webSocketFactory: createNodeWebSocketFactory(),
  });
  await client.connect();
  return client;
}

function loadAppVersion(): string {
  const packageJsonPath = path.resolve(__dirname, "../../../package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`Missing app version in ${packageJsonPath}`);
  }
  return packageJson.version;
}

export async function loadProtocolSchemas(): Promise<typeof import("@getpaseo/protocol/messages")> {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, "../../../../../packages/protocol/dist/messages.js"),
  ).href;
  return import(moduleUrl);
}
