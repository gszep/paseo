import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  continueNative,
  readContinuationReceipt,
  verifyContinuationReceipt,
  ContinuationError,
} from "@henkaku-center/chi-native/continuation";
import { captureNative, retryCaptureNative } from "@henkaku-center/chi-native/capture";
import {
  exchangeGitHubToken,
  readGitHubCliToken,
  type AuthState,
} from "@henkaku-center/chi-native/auth";
import { DEFAULT_BACKEND_URL, parseGitHubRemote } from "@henkaku-center/chi-native/repository";
import { append, boundedText, endpointUrl } from "@henkaku-center/chi-native/http";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { execCommand } from "../../utils/spawn.js";

const label = "chi.native";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const associationSchema = z.object({
  repo: z.string(),
  actor: z.string(),
  sourceId: hash.nullable(),
  head: hash.nullable(),
  error: z.string().nullable(),
});
type Association = z.infer<typeof associationSchema>;
const authSchema = z.object({ ok: z.literal(true), chiUserId: z.string() });
const reposSchema = z.object({
  ok: z.literal(true),
  repos: z.array(z.object({ repo: z.string() })),
});

export interface ChiConnectionOptions {
  home: string;
  serverId: string;
  authority?: ChiAuthority;
}
export interface ChiAuthority {
  endpoint: string;
  request: typeof fetch;
  login(): Promise<AuthState>;
}
const deployment: ChiAuthority = {
  endpoint: DEFAULT_BACKEND_URL,
  request: fetch,
  async login() {
    const githubToken = readGitHubCliToken();
    if (!githubToken) throw new Error("chi-github-login-required");
    return exchangeGitHubToken({ githubToken, backendUrl: DEFAULT_BACKEND_URL });
  },
};

export class ChiConnection {
  private readonly pending = new Map<string, Promise<Association>>();
  private readonly dirty = new Set<string>();
  private readonly continuing = new Set<string>();
  private get authority(): ChiAuthority {
    return this.options.authority ?? deployment;
  }
  constructor(
    private readonly manager: AgentManager,
    private readonly options: ChiConnectionOptions,
  ) {}

  private association(agent: ManagedAgent): Association | null {
    const encoded = agent.labels[label];
    return encoded ? associationSchema.parse(JSON.parse(encoded)) : null;
  }

  private async save(agentId: string, value: Association): Promise<void> {
    await this.manager.updateAgentMetadata(agentId, { labels: { [label]: JSON.stringify(value) } });
  }

  private async authorize(repo: string, cwd: string) {
    const remote = await execCommand("git", ["remote", "get-url", "origin"], {
      cwd,
      timeout: 5000,
    });
    const parsed = parseGitHubRemote(remote.stdout);
    if (!parsed || `github:${parsed.owner}/${parsed.repo}`.toLowerCase() !== repo.toLowerCase())
      throw new Error("chi-repository-mismatch");
    const session = await this.authority.login();
    const endpoint = endpointUrl(this.authority.endpoint);
    const get = async (path: string) => {
      const response = await this.authority.request(append(endpoint, path), {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${session.sessionToken}` },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`chi-http-${response.status}`);
      }
      return JSON.parse(await boundedText(response, 1024 * 1024));
    };
    const identity = authSchema.parse(await get("auth/session"));
    if (identity.chiUserId !== session.chiUserId) throw new Error("chi-identity-mismatch");
    const catalog = reposSchema.parse(await get("repos"));
    if (!catalog.repos.some((entry) => entry.repo === repo))
      throw new Error("chi-repository-denied");
    return session;
  }

  async share(agentId: string, selectedRepo?: string): Promise<Association> {
    const agent = this.manager.getAgent(agentId);
    if (!agent || agent.provider !== "opencode" || !agent.persistence)
      throw new Error("chi-native-agent-required");
    const remote = await execCommand("git", ["remote", "get-url", "origin"], {
      cwd: agent.cwd,
      timeout: 5000,
    });
    const parsed = parseGitHubRemote(remote.stdout);
    if (!parsed) throw new Error("chi-repository-mismatch");
    const repo = selectedRepo ?? `github:${parsed.owner}/${parsed.repo}`;
    const previous = this.association(agent);
    if (previous && previous.repo !== repo) throw new Error("chi-association-conflict");
    const auth = await this.authorize(repo, agent.cwd);
    if (previous && previous.actor !== auth.chiUserId) throw new Error("chi-identity-mismatch");
    if (!previous)
      await this.save(agentId, {
        repo,
        actor: auth.chiUserId,
        sourceId: null,
        head: null,
        error: null,
      });
    return this.capture(agentId, previous?.error === "evidence-http-409");
  }

  capture(agentId: string, retryConflict = false): Promise<Association> {
    this.dirty.add(agentId);
    const pending = this.pending.get(agentId);
    if (pending) return pending;
    const operation = (async () => {
      for (;;) {
        this.dirty.delete(agentId);
        try {
          const result = await this.captureOnce(agentId, retryConflict);
          if (!this.dirty.has(agentId)) return result;
        } catch (error) {
          if (safeChiError(error) !== "chi-session-busy" || !this.dirty.has(agentId)) throw error;
        }
        retryConflict = false;
      }
    })();
    this.pending.set(agentId, operation);
    void operation
      .finally(() => {
        this.pending.delete(agentId);
        this.dirty.delete(agentId);
      })
      .catch(() => undefined);
    return operation;
  }

  private async captureOnce(agentId: string, retryConflict: boolean): Promise<Association> {
    const agent = this.manager.getAgent(agentId);
    if (!agent || agent.provider !== "opencode" || !agent.persistence)
      throw new Error("chi-native-agent-required");
    const association = this.association(agent);
    if (!association) throw new Error("chi-share-required");
    try {
      if (agent.lifecycle === "running" || agent.lifecycle === "initializing")
        throw new Error("chi-session-busy");
      const settledTurns = [...agent.finalizedForegroundTurnIds];
      const auth = await this.authorize(association.repo, agent.cwd);
      if (auth.chiUserId !== association.actor) throw new Error("chi-identity-mismatch");
      const sessionId = agent.persistence.nativeHandle ?? agent.persistence.sessionId;
      const result = await this.manager.withNativeRuntime(sessionId, async (runtime) => {
        const native = JSON.stringify(await runtime.export(sessionId));
        const current = this.manager.getAgent(agentId);
        if (
          !current ||
          current.lifecycle === "running" ||
          current.lifecycle === "initializing" ||
          current.finalizedForegroundTurnIds.size !== settledTurns.length ||
          settledTurns.some((id) => !current.finalizedForegroundTurnIds.has(id))
        )
          throw new Error("chi-session-busy");
        const input = {
          endpoint: this.authority.endpoint,
          token: auth.sessionToken,
          repo: association.repo,
          sessionId,
          native,
          mapping: {
            instanceId: `${this.options.serverId}:opencode`,
            workspace: { hostId: this.options.serverId, path: agent.cwd },
          },
          expectedHead: association.head,
          visibility: "shared" as const,
          coverage: { kind: "export" as const, reason: null },
        };
        return retryConflict
          ? retryCaptureNative(input, auth.chiUserId, this.authority.request)
          : captureNative(input, this.authority.request);
      });
      const next = { ...association, sourceId: result.sourceId, head: result.head, error: null };
      await this.save(agentId, next);
      return next;
    } catch (error) {
      const code = safeChiError(error);
      await this.save(agentId, { ...association, error: code });
      throw new Error(code, { cause: error });
    }
  }

  afterTurn(agentId: string): void {
    const agent = this.manager.getAgent(agentId);
    if (!agent?.labels[label]) return;
    // Capture runs after manager turn reconciliation; the pending map coalesces
    // duplicate lifecycle notifications without polling or a second process.
    queueMicrotask(() => {
      void this.capture(agentId).catch(() => undefined);
    });
  }

  async continue(
    input: {
      repo: string;
      sourceId: string;
      snapshotId: string;
      cwd: string;
      requestId: string;
      workspaceId: string;
    },
    registration: {
      find(sessionId: string): Promise<ManagedAgent | null>;
      register(sessionId: string, labels: Record<string, string>): Promise<ManagedAgent>;
    },
  ) {
    if (this.continuing.has(input.requestId)) throw new Error("chi-continuation-in-progress");
    this.continuing.add(input.requestId);
    try {
      const auth = await this.authorize(input.repo, input.cwd);
      const receipts = join(this.options.home, "chi", "receipts");
      await mkdir(receipts, { recursive: true, mode: 0o700 });
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))
        throw new Error("chi-invalid-request-id");
      const local = this.manager
        .listAgents()
        .find(
          (agent) => agent.labels[label] && this.association(agent)?.sourceId === input.sourceId,
        );
      const nativeId = local?.persistence?.nativeHandle ?? local?.persistence?.sessionId ?? null;
      return await this.manager.withNativeRuntime(nativeId, async (transport) => {
        // The owner's namespace survives process restarts; its authenticated
        // loopback transport port does not. Native IDs remain owner-local.
        const runtime = { ...transport, identity: `${this.options.serverId}:opencode` };
        const operation = {
          endpoint: this.authority.endpoint,
          token: auth.sessionToken,
          repo: input.repo,
          sourceId: input.sourceId,
          snapshotId: input.snapshotId,
          workspace: input.cwd,
          receipt: join(receipts, `${input.requestId}.json`),
          runtime,
          owner: {
            actor: auth.chiUserId,
            workspaceId: input.workspaceId,
            endpoint: this.authority.endpoint,
          },
        };
        const previous = await readContinuationReceipt(operation, this.authority.request);
        const receipt = previous ?? (await continueNative(operation, this.authority.request));
        if (!receipt.destination.sessionId) throw new Error("chi-continuation-incomplete");
        const labels = {
          "chi.continuation": JSON.stringify({
            requestId: input.requestId,
            source: receipt.source,
            destination: receipt.destination,
            owner: receipt.owner,
          }),
          [label]: JSON.stringify({
            repo: input.repo,
            actor: auth.chiUserId,
            sourceId: null,
            head: null,
            error: null,
          }),
        };
        const existing = await registration.find(receipt.destination.sessionId);
        if (existing) {
          if (
            existing.provider !== "opencode" ||
            (existing.persistence?.nativeHandle ?? existing.persistence?.sessionId) !==
              receipt.destination.sessionId ||
            existing.cwd !== input.cwd ||
            existing.workspaceId !== input.workspaceId ||
            existing.labels["chi.continuation"] !== labels["chi.continuation"]
          )
            throw new Error("chi-continuation-registration-mismatch");
          return { sessionId: receipt.destination.sessionId, snapshot: existing };
        }
        if (previous) await verifyContinuationReceipt(receipt, runtime);
        const snapshot = await registration.register(receipt.destination.sessionId, labels);
        return { sessionId: receipt.destination.sessionId, snapshot };
      });
    } finally {
      this.continuing.delete(input.requestId);
    }
  }
}

export function safeChiError(error: unknown): string {
  if (error instanceof ContinuationError) return error.message;
  if (error instanceof Error && /^(?:chi|evidence|capture)-[a-z0-9-]+$/.test(error.message))
    return error.message;
  return "chi-operation-failed";
}
