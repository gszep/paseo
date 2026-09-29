import { mkdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  continueNative,
  readContinuationReceipt,
  verifyContinuationReceipt,
  ContinuationError,
  type NativeRuntime,
} from "@henkaku-center/chi-native/continuation";
import {
  captureNative,
  retryCaptureNative,
  prepareNativeCapture,
} from "@henkaku-center/chi-native/capture";
import {
  ConversationClient,
  readConversationReceipt,
  reserveConversationReceipt,
  writeConversationReceipt,
  publishConversationReceipt,
  syncConversationReceiptDirectory,
  type ConversationDestination,
  type AdoptRequest,
  type ReserveRequest,
  type CancelRequest,
  type ClaimRequest,
  type PublishRequest,
} from "@henkaku-center/chi-native/conversations";
import {
  exchangeGitHubToken,
  readGitHubCliToken,
  type AuthState,
} from "@henkaku-center/chi-native/auth";
import { DEFAULT_BACKEND_URL, parseGitHubRemote } from "@henkaku-center/chi-native/repository";
import {
  append,
  boundedText,
  endpointUrl,
  EvidenceHttpError,
} from "@henkaku-center/chi-native/http";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { readQuarantinedSessions } from "./quarantine.js";
import { execCommand } from "../../utils/spawn.js";
import { ChiMentions, type MentionIdentity } from "./mentions.js";
import type { ChiMentionOperation, ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { ChiOperationError } from "@getpaseo/protocol/chi-mentions";
import type { ChiSyncDestination, MutableChiConfig } from "@getpaseo/protocol/messages";
import { createSessionLogin } from "./session-login.js";
import { ParticipantCache } from "./participant-cache.js";
import { classifyMentionFailure } from "./mention-failure.js";
import {
  parseChiDestinations,
  resolveChiDestination,
  resolveChiDestinationForRepo,
  type ChiDestinationsConfig,
  type ResolvedChiDestination,
} from "./destinations.js";

const label = "chi.native";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const associationSchema = z.object({
  repo: z.string(),
  actor: z.string(),
  sourceId: hash.nullable(),
  head: hash.nullable(),
  error: z.string().nullable(),
  conversationId: z.string().optional(),
  blocked: z.boolean().optional(),
  // Pinned at association creation. Optional for migration of pre-P1 labels.
  destination: z.string().optional(),
  endpoint: z.string().optional(),
  audience: z.enum(["private", "shared"]).optional(),
  // Set when a configured destination no longer matches; uploads pause until resolved.
  paused: z.boolean().optional(),
  // Durable sync-needed marker: a capture is outstanding across restarts.
  capturePending: z.boolean().optional(),
  // True for associations created by the explicit canonical-transfer path on an
  // unmapped repository; they keep legacy default-deployment capture.
  explicit: z.boolean().optional(),
  adopt: z.object({ id: z.string(), sourceId: hash, expectedHead: hash }).optional(),
  reserve: z
    .object({
      id: z.string(),
      revision: z.number(),
      transferId: z.string(),
      sourceId: hash,
      snapshotId: hash,
      destination: z.object({
        instanceId: z.string(),
        workspace: z.object({ hostId: z.string(), path: z.string() }),
      }),
    })
    .optional(),
  cancel: z.object({ id: z.string(), revision: z.number(), transferId: z.string() }).optional(),
});
type Association = z.infer<typeof associationSchema>;
interface ContinueSelection {
  repo: string;
  sourceId: string;
  snapshotId: string;
  cwd: string;
  requestId: string;
  workspaceId: string;
  canonical?: { conversationId: string; transferId: string };
}
interface ClaimJournal {
  identity: {
    repo: string;
    endpoint: string;
    actor: string;
    workspaceId: string;
    destination: ConversationDestination;
    canonical: ContinueSelection["canonical"];
  };
  claim: ClaimRequest;
}
function assertRegistration(
  existing: ManagedAgent,
  input: ContinueSelection,
  sessionId: string,
  continuation: string,
) {
  if (
    existing.provider !== "opencode" ||
    (existing.persistence?.nativeHandle ?? existing.persistence?.sessionId) !== sessionId ||
    existing.cwd !== input.cwd ||
    existing.workspaceId !== input.workspaceId ||
    existing.labels["chi.continuation"] !== continuation
  )
    throw new Error("chi-continuation-registration-mismatch");
}
const authSchema = z.object({ ok: z.literal(true), chiUserId: z.string() });
const reposSchema = z.object({
  ok: z.literal(true),
  repos: z.array(z.object({ repo: z.string() })),
});

export interface ChiConnectionOptions {
  home: string;
  serverId: string;
  authority?: ChiAuthority;
  /** Live daemon `chi` config; re-read on every resolution so reloads apply. */
  getChiConfig?: () => MutableChiConfig | undefined;
  /** Persisted agents not yet loaded into memory, for restart reconciliation. */
  listStoredAgents?: () => Promise<readonly StoredChiAgent[]>;
  getStoredAgent?: (agentId: string) => Promise<StoredChiAgent | null>;
}
/** Minimal persisted-agent shape needed to reconcile a sync without a live session. */
export interface StoredChiAgent {
  id: string;
  cwd: string;
  provider: string;
  workspaceId?: string | null;
  persistence?: { nativeHandle?: string | null; sessionId?: string | null } | null;
  labels?: Record<string, string>;
  archivedAt?: string | null;
}
interface CaptureTarget {
  id: string;
  cwd: string;
  provider: string;
  persistence: { nativeHandle?: string | null; sessionId?: string | null };
  lifecycle: string;
  finalizedForegroundTurnIds: Set<string>;
  labels: Record<string, string>;
  live: boolean;
}
export interface ChiAuthority {
  endpoint: string;
  request: typeof fetch;
  login(): Promise<AuthState & { credentialGeneration?: string }>;
  invalidate(): void;
}
function createDeployment(endpoint = DEFAULT_BACKEND_URL): ChiAuthority {
  return {
    endpoint,
    request: fetch,
    ...createSessionLogin(readGitHubCliToken, (githubToken) =>
      exchangeGitHubToken({ githubToken, backendUrl: endpoint }),
    ),
  };
}

export class ChiConnection {
  readonly mentions: ChiMentions;
  private readonly participants = new ParticipantCache();
  private readonly registrationPermits = new WeakMap<
    object,
    { sessionId: string; cwd: string; workspaceId: string; labels: string }
  >();
  quarantinedSessions() {
    return readQuarantinedSessions(
      this.options.home,
      this.options.serverId,
      this.authority.endpoint,
    );
  }
  async assertImportAllowed(input: {
    provider: string;
    providerHandleId: string;
    cwd: string;
    workspaceId: string;
    labels?: Record<string, string>;
    chiRegistration?: object;
  }): Promise<void> {
    if (input.provider !== "opencode") return;
    const permit = input.chiRegistration && this.registrationPermits.get(input.chiRegistration);
    if (
      permit &&
      permit.sessionId === input.providerHandleId &&
      permit.cwd === input.cwd &&
      permit.workspaceId === input.workspaceId &&
      permit.labels === JSON.stringify(input.labels)
    )
      return;
    if (
      (await this.quarantinedSessions()).some(
        (session) => session.sessionId === input.providerHandleId && session.cwd === input.cwd,
      )
    )
      throw new Error("chi-conversation-recovery-required");
  }
  private exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    return this.manager.withChiAdmission(key, action);
  }
  private client(repo: string, token: string, endpoint = this.authority.endpoint) {
    return new ConversationClient({ repo, token, endpoint }, this.authorityFor(endpoint).request);
  }
  async assertCurrent(agent: { cwd: string; labels: Record<string, string> }): Promise<void> {
    const encoded = agent.labels[label];
    if (!encoded) return;
    const association = associationSchema.parse(JSON.parse(encoded));
    if (association.blocked) throw new Error("chi-conversation-pending");
    if (!association.conversationId) return;
    const endpoint = this.endpointFor(association.repo, association.endpoint);
    const auth = await this.authorize(association.repo, agent.cwd, this.authorityFor(endpoint));
    if (auth.chiUserId !== association.actor) throw new Error("chi-identity-mismatch");
    const { conversation } = await this.client(association.repo, auth.sessionToken, endpoint).get({
      id: association.conversationId,
    });
    if (conversation.current.sourceId !== association.sourceId)
      throw new Error("chi-conversation-stale");
    if (conversation.pending) throw new Error("chi-conversation-pending");
  }
  withPromptAdmission<T>(agentId: string, start: () => Promise<T>): Promise<T> {
    return this.exclusive(agentId, async () => {
      const agent = this.manager.getAgent(agentId);
      if (!agent) throw new Error("chi-native-agent-required");
      await this.assertCurrent(agent);
      return start();
    });
  }

  async prepare(agentId: string, transferId: string, destination: ConversationDestination) {
    return this.exclusive(agentId, async () => {
      const agent = this.manager.getAgent(agentId);
      if (!agent || agent.provider !== "opencode" || !agent.persistence)
        throw new Error("chi-native-agent-required");
      if (this.manager.isChiAgentBusy(agentId)) throw new Error("chi-session-busy");
      let association = this.association(agent);
      if (!association) association = await this.share(agentId);
      const endpoint = this.endpointFor(association.repo, association.endpoint);
      const auth = await this.authorize(association.repo, agent.cwd, this.authorityFor(endpoint));
      if (auth.chiUserId !== association.actor) throw new Error("chi-identity-mismatch");
      const client = this.client(association.repo, auth.sessionToken, endpoint);
      if (association.reserve?.transferId === transferId)
        return client.reserve(association.reserve);
      if (association.blocked && association.reserve) throw new Error("chi-conversation-pending");
      if (association.conversationId && !association.blocked) await this.assertCurrent(agent);
      // Persist admission closure before exporting. A crash leaves a visible block.
      await this.patchAssociation(agentId, { blocked: true });
      association = await this.capture(agentId);
      if (!association.sourceId || !association.head) throw new Error("chi-capture-incomplete");
      let conversationId = association.conversationId;
      if (!conversationId) {
        const adopt: AdoptRequest = association.adopt ?? {
          id: randomUUID(),
          sourceId: association.sourceId,
          expectedHead: association.head,
        };
        association = await this.patchAssociation(agentId, { adopt });
        const result = await client.adopt(adopt);
        conversationId = result.conversation.id;
        association = await this.patchAssociation(agentId, { conversationId });
      }
      const { conversation } = await client.get({ id: conversationId });
      if (conversation.current.sourceId !== association.sourceId || conversation.pending)
        throw new Error("chi-conversation-stale");
      const reserve: ReserveRequest = {
        id: conversationId,
        revision: conversation.revision,
        transferId,
        sourceId: association.sourceId,
        snapshotId: association.head!,
        destination,
      };
      await this.patchAssociation(agentId, { reserve, cancel: undefined });
      return client.reserve(reserve);
    });
  }

  async reconcile(agentId: string, cancel = false) {
    return this.exclusive(agentId, async () => {
      const agent = this.manager.getAgent(agentId);
      const association = agent && this.association(agent);
      if (!agent || !association?.conversationId) throw new Error("chi-conversation-required");
      const auth = await this.authorize(association.repo, agent.cwd);
      if (auth.chiUserId !== association.actor) throw new Error("chi-identity-mismatch");
      const client = this.client(association.repo, auth.sessionToken);
      let result = await client.get({
        id: association.conversationId,
        ...(association.reserve ? { transferId: association.reserve.transferId } : {}),
      });
      if (cancel) {
        if (!association.reserve) throw new Error("chi-conversation-required");
        const request: CancelRequest = association.cancel ?? {
          id: association.conversationId,
          revision: result.conversation.revision,
          transferId: association.reserve.transferId,
        };
        const saved = await this.patchAssociation(agentId, (current) => ({
          cancel: current.cancel ?? request,
        }));
        result = await client.cancel(saved.cancel!);
      }
      const stale = result.conversation.current.sourceId !== association.sourceId;
      await this.patchAssociation(agentId, {
        blocked: stale || result.conversation.pending !== null,
      });
      // Canonical authorization remains the gate even when runtime closure fails.
      if (stale) await this.manager.archiveAgent(agentId);
      return result;
    });
  }
  private readonly pending = new Map<string, Promise<Association>>();
  private readonly dirty = new Set<string>();
  private readonly continuing = new Set<string>();
  private readonly authority: ChiAuthority;
  private readonly authorityByEndpoint = new Map<string, ChiAuthority>();
  constructor(
    private readonly manager: AgentManager,
    private readonly options: ChiConnectionOptions,
  ) {
    this.authority = options.authority ?? createDeployment();
    this.authorityByEndpoint.set(this.authority.endpoint, this.authority);
    this.mentions = new ChiMentions(options.home, {
      endpoint: this.authority.endpoint,
      request: async (url, init) => {
        const response = await this.authority.request(url, init);
        if ([401, 403, 404].includes(response.status)) {
          this.loseMentionAuthority();
        }
        return response;
      },
    });
  }

  private chiConfig(): ChiDestinationsConfig | null {
    return parseChiDestinations(this.options.getChiConfig?.());
  }

  /** One authority per endpoint; an injected fixture authority overrides them all. */
  private authorityFor(endpoint: string): ChiAuthority {
    if (this.options.authority) return this.options.authority;
    const existing = this.authorityByEndpoint.get(endpoint);
    if (existing) return existing;
    const created = createDeployment(endpoint);
    this.authorityByEndpoint.set(endpoint, created);
    return created;
  }

  private async resolveForCwd(cwd: string): Promise<ResolvedChiDestination | null> {
    const config = this.chiConfig();
    if (!config) return null;
    try {
      const remote = await execCommand("git", ["remote", "get-url", "origin"], {
        cwd,
        timeout: 5000,
      });
      return resolveChiDestination(config, remote.stdout);
    } catch {
      return null;
    }
  }

  private endpointFor(repo: string, pinned?: string): string {
    if (pinned) return pinned;
    const resolved = resolveChiDestinationForRepo(this.chiConfig(), repo);
    return resolved?.endpoint ?? this.authority.endpoint;
  }

  private loseMentionAuthority() {
    this.participants.clear();
    this.authority.invalidate();
  }

  private async mentionIdentity(cwd: string, directoryOnly = false): Promise<MentionIdentity> {
    try {
      const remote = await execCommand("git", ["remote", "get-url", "origin"], {
        cwd,
        timeout: 5000,
      });
      const parsed = parseGitHubRemote(remote.stdout);
      if (!parsed) throw new Error("chi-repository-mismatch");
      const repo = `github:${parsed.owner}/${parsed.repo}`;
      const auth = directoryOnly ? await this.authority.login() : await this.authorize(repo, cwd);
      return {
        repo,
        actor: auth.chiUserId.toLowerCase(),
        token: auth.sessionToken,
        credentialGeneration: auth.credentialGeneration,
      };
    } catch (error) {
      this.loseMentionAuthority();
      // A failed authority acquisition invalidates protected data even when token
      // exchange or Git reports an error outside the public Chi code vocabulary.
      throw new ChiOperationError(safeChiError(error), { accessLost: true, outcome: "unknown" });
    }
  }

  async prepareMentions(
    agentId: string,
    messageId: string | undefined,
    text: string,
    recipients: string[],
    expectedContext?: ChiMentionContext,
    admission?: string,
  ) {
    const agent = this.manager.getAgent(agentId);
    if (!agent || agent.provider !== "opencode" || !messageId)
      throw new Error("chi-native-agent-required");
    const identity = await this.mentionIdentity(agent.cwd);
    this.requireMentionContext(identity, expectedContext);
    let association = this.association(agent);
    if (!association) {
      const resolved = resolveChiDestinationForRepo(this.chiConfig(), identity.repo);
      // Mentions remain a deliberate action on a local workspace only.
      if (!resolved) throw new Error("chi-share-required");
      association = await this.autoAssociate(agentId, resolved, identity.actor);
    }
    if (identity.actor !== association.actor.toLowerCase() || identity.repo !== association.repo)
      throw new Error("chi-identity-mismatch");
    if (!admission) throw new Error("chi-mention-admission-required");
    await this.mentions.prepare({ agentId, messageId, text, recipients, identity, admission });
  }

  private mentionContext(identity: MentionIdentity): ChiMentionContext {
    return {
      actor: identity.actor,
      repo: identity.repo,
      deployment: this.authority.endpoint,
      generation: createHash("sha256")
        .update(
          JSON.stringify([
            this.authority.endpoint,
            identity.actor,
            identity.repo,
            identity.credentialGeneration ?? identity.token,
          ]),
        )
        .digest("hex"),
    };
  }

  private requireMentionContext(identity: MentionIdentity, expected?: ChiMentionContext) {
    const current = this.mentionContext(identity);
    if (
      !expected ||
      current.actor !== expected.actor ||
      current.repo !== expected.repo ||
      current.generation !== expected.generation
    )
      throw new Error("chi-mention-context-changed");
  }

  async mentionOperation(
    cwd: string,
    workspaceId: string,
    operation: ChiMentionOperation,
    expectedContext?: ChiMentionContext,
  ) {
    try {
      return await this.readMentionOperation(cwd, workspaceId, operation, expectedContext);
    } catch (error) {
      if (classifyMentionFailure(error).accessLost) {
        this.loseMentionAuthority();
      }
      throw error;
    }
  }

  async inboxOperation(operation: ChiMentionOperation, expected?: ChiMentionContext) {
    const identity = async (): Promise<MentionIdentity> => {
      try {
        const auth = await this.authority.login();
        return {
          actor: auth.chiUserId.toLowerCase(),
          token: auth.sessionToken,
          credentialGeneration: auth.credentialGeneration,
          repo: "*",
        };
      } catch (error) {
        throw new ChiOperationError(safeChiError(error), { accessLost: true, outcome: "unknown" });
      }
    };
    try {
      const current = await identity();
      const context = this.mentionContext(current);
      if (operation.action === "scope")
        return { context, result: { kind: "scope" as const, actor: current.actor } };
      this.requireMentionContext(current, expected);
      if (
        operation.action === "participants" ||
        operation.action === "delivery" ||
        operation.action === "retry" ||
        operation.action === "list"
      )
        throw new Error("chi-mention-workspace-required");
      const repo = operation.action === "inbox" ? "*" : operation.repo;
      if (!repo) throw new Error("chi-mention-repository-required");
      // Backend authorizes the supplied repository; inbox transport needs no local checkout.
      const result = await this.mentions.execute({ ...current, repo }, operation);
      this.requireMentionContext(await identity(), context);
      return { context, result };
    } catch (error) {
      if (classifyMentionFailure(error).accessLost) this.loseMentionAuthority();
      throw error;
    }
  }

  private async readMentionOperation(
    cwd: string,
    workspaceId: string,
    operation: ChiMentionOperation,
    expectedContext?: ChiMentionContext,
  ) {
    const directoryOnly = operation.action === "scope" || operation.action === "participants";
    const identity = await this.mentionIdentity(cwd, directoryOnly);
    const context = this.mentionContext(identity);
    const workspace = JSON.stringify([workspaceId, cwd]);
    this.participants.observe(workspace, identity);
    const generation = this.participants.generation;
    if (directoryOnly) {
      if (operation.action !== "scope") this.requireMentionContext(identity, expectedContext);
      const participants = await this.participants.read(workspace, identity, async () => {
        // /participants authorizes the session and x-chi-repo, and verifies self below.
        // Fetching the entire /repos catalog adds no authority to this directory read.
        const result = await this.mentions.execute(identity, { action: "participants" });
        if (result.kind !== "participants") throw new Error("chi-mention-invalid-response");
        return result.participants;
      });
      const current = await this.mentionIdentity(cwd, true);
      this.participants.observe(workspace, current);
      this.requireMentionContext(current, context);
      if (this.participants.generation !== generation)
        throw new Error("chi-mention-context-changed");
      const result =
        operation.action === "scope"
          ? { kind: "scope" as const, actor: identity.actor }
          : { kind: "participants" as const, actor: identity.actor, participants };
      return { context, result };
    }
    this.requireMentionContext(identity, expectedContext);
    const result = await this.executeMentionOperation(cwd, workspaceId, identity, operation);
    // A delayed read cannot republish data after the host changed identity/repository.
    this.requireMentionContext(await this.mentionIdentity(cwd), context);
    return { context, result };
  }

  private async executeMentionOperation(
    cwd: string,
    workspaceId: string,
    identity: MentionIdentity,
    operation: Exclude<ChiMentionOperation, { action: "scope" }>,
  ) {
    if (operation.action !== "delivery" && operation.action !== "retry")
      return this.mentions.execute(identity, operation);
    const agent = this.manager.getAgent(operation.agentId);
    if (!agent || agent.workspaceId !== workspaceId || agent.cwd !== cwd)
      throw new Error("chi-native-agent-required");
    if (operation.action === "retry") {
      if (this.manager.isChiAgentBusy(agent.id)) throw new Error("chi-session-busy");
      if (await this.mentions.retry(agent.id, identity)) await this.capture(agent.id);
    }
    return this.mentions.status(agent.id, identity);
  }

  private association(agent: ManagedAgent): Association | null {
    const encoded = agent.labels[label];
    return encoded ? associationSchema.parse(JSON.parse(encoded)) : null;
  }

  private async patchAssociation(
    agentId: string,
    patch: Partial<Association> | ((current: Association) => Partial<Association>),
  ): Promise<Association> {
    const value = await this.manager.updateAgentLabel(agentId, label, (encoded) => {
      if (!encoded) throw new Error("chi-share-required");
      const current = associationSchema.parse(JSON.parse(encoded));
      return JSON.stringify({
        ...current,
        ...(typeof patch === "function" ? patch(current) : patch),
      });
    });
    return associationSchema.parse(JSON.parse(value));
  }

  private async authorize(repo: string, cwd: string, authority: ChiAuthority = this.authority) {
    try {
      const remote = await execCommand("git", ["remote", "get-url", "origin"], {
        cwd,
        timeout: 5000,
      });
      const parsed = parseGitHubRemote(remote.stdout);
      if (!parsed || `github:${parsed.owner}/${parsed.repo}`.toLowerCase() !== repo.toLowerCase())
        throw new Error("chi-repository-mismatch");
      const session = await authority.login();
      const endpoint = endpointUrl(authority.endpoint);
      const get = async (path: string) => {
        const response = await authority.request(append(endpoint, path), {
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
    } catch (error) {
      if (classifyMentionFailure(error).accessLost) this.loseMentionAuthority();
      throw error;
    }
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
    const resolved = resolveChiDestinationForRepo(this.chiConfig(), repo);
    const endpoint = resolved?.endpoint ?? DEFAULT_BACKEND_URL;
    const auth = await this.authorize(repo, agent.cwd, this.authorityFor(endpoint));
    const encoded = await this.manager.updateAgentLabel(agentId, label, (current) => {
      if (current) {
        const previous = associationSchema.parse(JSON.parse(current));
        if (previous.repo !== repo) throw new Error("chi-association-conflict");
        if (previous.actor !== auth.chiUserId) throw new Error("chi-identity-mismatch");
        return current;
      }
      // Explicit canonical-transfer association. A mapped repository pins the
      // configured destination; an unmapped one keeps the legacy default
      // deployment and is never auto-created.
      return JSON.stringify({
        repo,
        actor: auth.chiUserId,
        sourceId: null,
        head: null,
        error: null,
        ...(resolved
          ? {
              destination: resolved.destinationId,
              endpoint: resolved.endpoint,
              audience: resolved.audience,
            }
          : { explicit: true, endpoint }),
      });
    });
    const previous = associationSchema.parse(JSON.parse(encoded));
    return this.capture(agentId, /^evidence-http-409(?:-|$)/.test(previous.error ?? ""));
  }

  /** Create the auto-association label without requiring the network. */
  private async autoAssociate(
    agentId: string,
    resolved: ResolvedChiDestination,
    actor = "",
  ): Promise<Association> {
    const encoded = await this.manager.updateAgentLabel(agentId, label, (current) => {
      if (current) return current;
      return JSON.stringify({
        repo: resolved.repo,
        actor,
        sourceId: null,
        head: null,
        error: null,
        destination: resolved.destinationId,
        endpoint: resolved.endpoint,
        audience: resolved.audience,
        capturePending: true,
      });
    });
    return associationSchema.parse(JSON.parse(encoded));
  }

  /** A live agent when loaded, otherwise the persisted record needed to export it. */
  private async captureTarget(agentId: string): Promise<CaptureTarget | null> {
    const live = this.manager.getAgent(agentId);
    if (live)
      return {
        id: live.id,
        cwd: live.cwd,
        provider: live.provider,
        persistence: live.persistence ?? {},
        lifecycle: live.lifecycle,
        finalizedForegroundTurnIds: live.finalizedForegroundTurnIds,
        labels: live.labels,
        live: true,
      };
    const stored = await this.options.getStoredAgent?.(agentId);
    if (!stored || stored.provider !== "opencode" || !stored.persistence) return null;
    return {
      id: stored.id,
      cwd: stored.cwd,
      provider: stored.provider,
      persistence: stored.persistence,
      lifecycle: "idle",
      finalizedForegroundTurnIds: new Set<string>(),
      labels: stored.labels ?? {},
      live: false,
    };
  }

  private async ensureAssociation(target: CaptureTarget): Promise<Association> {
    const encoded = target.labels[label];
    if (encoded) return associationSchema.parse(JSON.parse(encoded));
    const resolved = await this.resolveForTarget(target);
    if (!resolved) throw new Error("chi-share-required");
    return this.autoAssociate(target.id, resolved);
  }

  private async resolveForTarget(target: CaptureTarget): Promise<ResolvedChiDestination | null> {
    if (target.provider !== "opencode") return null;
    return this.resolveForCwd(target.cwd);
  }

  capture(agentId: string, retryConflict = false): Promise<Association> {
    this.dirty.add(agentId);
    const pending = this.pending.get(agentId);
    if (pending) return pending;
    const operation = (async () => {
      for (;;) {
        this.dirty.delete(agentId);
        try {
          const target = await this.captureTarget(agentId);
          if (!target) throw new Error("chi-native-agent-required");
          await this.ensureAssociation(target);
          const fresh = (await this.captureTarget(agentId)) ?? target;
          const result = await this.captureOnce(fresh, retryConflict);
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

  private async captureOnce(target: CaptureTarget, retryConflict: boolean): Promise<Association> {
    const agentId = target.id;
    let association = target.labels[label]
      ? associationSchema.parse(JSON.parse(target.labels[label]!))
      : null;
    if (!association) throw new Error("chi-share-required");
    association = await this.reconcileAssociation(agentId, association);
    if (association.paused) throw new Error(association.error ?? "chi-destination-paused");
    try {
      if (association.conversationId && !association.sourceId)
        throw new Error("chi-conversation-publication-pending");
      if (target.lifecycle === "running" || target.lifecycle === "initializing")
        throw new Error("chi-session-busy");
      const settledTurns = [...target.finalizedForegroundTurnIds];
      const endpoint = this.endpointFor(association.repo, association.endpoint);
      const authority = this.authorityFor(endpoint);
      const auth = await this.authorize(association.repo, target.cwd, authority);
      if (!association.actor) {
        association = await this.patchAssociation(agentId, { actor: auth.chiUserId });
      } else if (auth.chiUserId !== association.actor) {
        throw new Error("chi-identity-mismatch");
      }
      const pinned: Association = association;
      await this.patchAssociation(agentId, { capturePending: true });
      const sessionId = target.persistence.nativeHandle ?? target.persistence.sessionId;
      if (!sessionId) throw new Error("chi-native-agent-required");
      return await this.manager.withNativeRuntime(sessionId, async (runtime) => {
        const native = JSON.stringify(await runtime.export(sessionId));
        if (target.live) {
          const current = this.manager.getAgent(agentId);
          if (
            !current ||
            current.lifecycle === "running" ||
            current.lifecycle === "initializing" ||
            current.finalizedForegroundTurnIds.size !== settledTurns.length ||
            settledTurns.some((id) => !current.finalizedForegroundTurnIds.has(id))
          )
            throw new Error("chi-session-busy");
        }
        const input = {
          endpoint,
          token: auth.sessionToken,
          repo: pinned.repo,
          sessionId,
          native,
          mapping: {
            instanceId: `${this.options.serverId}:opencode`,
            workspace: { hostId: this.options.serverId, path: target.cwd },
          },
          expectedHead: pinned.head,
          visibility: pinned.audience ?? ("private" as const),
          coverage: { kind: "export" as const, reason: null },
        };
        const captured = await (retryConflict
          ? retryCaptureNative(input, auth.chiUserId, authority.request)
          : captureNative(input, authority.request));
        const parsed = prepareNativeCapture(input);
        const updated = await this.patchAssociation(agentId, {
          sourceId: captured.sourceId,
          head: captured.head,
          error: null,
          capturePending: false,
        });
        // Mentions stay on the primary deployment; a peer destination's mentions
        // are out of P1 scope and are never cross-posted.
        if (endpoint === this.authority.endpoint) {
          await this.mentions.captured({
            agentId,
            identity: {
              repo: pinned.repo,
              actor: auth.chiUserId.toLowerCase(),
              token: auth.sessionToken,
            },
            sourceId: captured.sourceId,
            snapshot: captured.head,
            messages: parsed.entries.map((entry) => ({
              id: entry.nativeId,
              payload: parsed.payloads[entry.revision]!,
            })),
          });
        }
        return updated;
      });
    } catch (error) {
      const code = safeChiError(error);
      await this.patchAssociation(agentId, { error: code, capturePending: true });
      throw new Error(code, { cause: error });
    }
  }

  /**
   * Bind a pre-P1 association to its configured destination, or pause it when the
   * repository no longer maps or the pinned endpoint changed. Pausing never moves
   * data and never blocks prompts.
   */
  private async reconcileAssociation(
    agentId: string,
    association: Association,
  ): Promise<Association> {
    const config = this.chiConfig();
    if (!config) return association;
    if (association.destination) {
      const configured = config.destinations[association.destination];
      if (!configured || configured.endpoint !== association.endpoint)
        return this.pauseAssociation(agentId, "chi-destination-changed");
      return association;
    }
    if (association.explicit) {
      return this.patchAssociation(agentId, {
        endpoint: association.endpoint ?? DEFAULT_BACKEND_URL,
        paused: false,
      });
    }
    const resolved = resolveChiDestinationForRepo(config, association.repo);
    if (!resolved || resolved.endpoint !== DEFAULT_BACKEND_URL)
      return this.pauseAssociation(
        agentId,
        resolved ? "chi-destination-mismatch" : "chi-destination-unmapped",
      );
    return this.patchAssociation(agentId, {
      destination: resolved.destinationId,
      endpoint: resolved.endpoint,
      audience: association.audience ?? resolved.audience,
      paused: false,
    });
  }

  private pauseAssociation(agentId: string, code: string): Promise<Association> {
    return this.patchAssociation(agentId, { paused: true, capturePending: false, error: code });
  }

  afterTurn(agentId: string): void {
    const agent = this.manager.getAgent(agentId);
    if (!agent || agent.provider !== "opencode") return;
    const association = this.association(agent);
    // A genuinely local workspace (no mapping at all) stays quiet.
    if (!association && !this.chiConfig()) return;
    // Capture runs after manager turn reconciliation; the pending map coalesces
    // duplicate lifecycle notifications without polling or a second process.
    queueMicrotask(() => {
      void this.capture(agentId).catch(() => undefined);
    });
  }

  private async candidateLabels(): Promise<Array<{ id: string; labels: Record<string, string> }>> {
    const candidates = new Map<string, Record<string, string>>();
    for (const agent of this.manager.listAgents()) candidates.set(agent.id, agent.labels);
    for (const record of (await this.options.listStoredAgents?.()) ?? []) {
      if (record.archivedAt || candidates.has(record.id)) continue;
      candidates.set(record.id, record.labels ?? {});
    }
    return Array.from(candidates, ([id, labels]) => ({ id, labels }));
  }

  private parseAssociation(encoded: string | undefined): Association | null {
    if (!encoded) return null;
    try {
      return associationSchema.parse(JSON.parse(encoded));
    } catch {
      return null;
    }
  }

  /** Re-resolve every association after a live `chi` config reload. */
  async onDestinationsChanged(): Promise<void> {
    for (const candidate of await this.candidateLabels()) {
      if (!candidate.labels[label]) continue;
      void this.capture(candidate.id).catch(() => undefined);
    }
  }

  /** Retry captures that are outstanding across a restart or reconnect. */
  async reconcilePending(): Promise<void> {
    for (const candidate of await this.candidateLabels()) {
      const association = this.parseAssociation(candidate.labels[label]);
      if (!association || association.paused || !association.capturePending) continue;
      void this.capture(candidate.id).catch(() => undefined);
    }
  }

  private async workspaceIdentities(
    workspaceId: string,
  ): Promise<Array<{ id: string; association: Association | null }>> {
    const identities = this.manager
      .listAgents()
      .filter((agent) => agent.workspaceId === workspaceId && agent.provider === "opencode")
      .map((agent) => ({ id: agent.id, association: this.association(agent) }));
    const seen = new Set(identities.map((identity) => identity.id));
    for (const record of (await this.options.listStoredAgents?.()) ?? []) {
      if (
        record.archivedAt ||
        record.provider !== "opencode" ||
        record.workspaceId !== workspaceId ||
        seen.has(record.id)
      )
        continue;
      seen.add(record.id);
      identities.push({
        id: record.id,
        association: this.parseAssociation(record.labels?.[label]),
      });
    }
    return identities;
  }

  private destinationFromIdentities(
    identities: Array<{ association: Association | null }>,
    config: ChiDestinationsConfig | null,
  ): ResolvedChiDestination | null {
    for (const { association } of identities) {
      if (!association?.destination) continue;
      const configured = config?.destinations[association.destination];
      if (!configured) continue;
      return {
        repo: association.repo,
        destinationId: association.destination,
        name: configured.name,
        endpoint: association.endpoint ?? configured.endpoint,
        audience: association.audience ?? "private",
      };
    }
    return null;
  }

  private aggregateSync(identities: Array<{ association: Association | null }>): {
    pending: boolean;
    error: string | null;
  } {
    let pending = false;
    let error: string | null = null;
    for (const { association } of identities) {
      if (!association) continue;
      if (association.capturePending) pending = true;
      if (association.error) error = association.error;
    }
    return { pending, error };
  }

  async syncStatus(input: {
    workspaceId: string;
    cwd: string;
    retry?: boolean;
  }): Promise<{ destination: ChiSyncDestination | null; pending: boolean; error: string | null }> {
    const identities = await this.workspaceIdentities(input.workspaceId);
    if (input.retry)
      for (const identity of identities) void this.capture(identity.id).catch(() => undefined);
    const resolved =
      this.destinationFromIdentities(identities, this.chiConfig()) ??
      (await this.resolveForCwd(input.cwd));
    const { pending, error } = this.aggregateSync(identities);
    return {
      destination: resolved
        ? {
            id: resolved.destinationId,
            name: resolved.name,
            endpoint: resolved.endpoint,
            audience: resolved.audience,
          }
        : null,
      pending,
      error,
    };
  }

  private async claimJournal(
    input: ContinueSelection,
    actor: string,
    client: ConversationClient,
    destination: ConversationDestination,
    path: string,
  ): Promise<ClaimJournal> {
    const canonical = input.canonical;
    if (!canonical) throw new Error("chi-transfer-preparation-required");
    const selected = await client.get({
      id: canonical.conversationId,
      transferId: canonical.transferId,
    });
    if (
      selected.conversation.ownerId !== actor.toLowerCase() ||
      selected.transfer?.sourceId !== input.sourceId ||
      selected.transfer.snapshotId !== input.snapshotId ||
      JSON.stringify(selected.transfer.destination) !== JSON.stringify(destination) ||
      selected.transfer.phase === "canceled"
    )
      throw new Error("chi-conversation-selection-mismatch");
    const identity = {
      repo: input.repo,
      sourceId: input.sourceId,
      snapshotId: input.snapshotId,
      endpoint: this.authority.endpoint,
      actor,
      workspaceId: input.workspaceId,
      destination,
      canonical,
    };
    const saved = await readConversationReceipt(path);
    if (saved !== null) {
      const parsed = z
        .object({
          identity: z.unknown(),
          claim: z.object({
            id: z.string(),
            revision: z.number().int().positive(),
            transferId: z.string(),
            claimId: z.string(),
            destination: z.unknown(),
          }),
        })
        .safeParse(saved);
      if (!parsed.success || JSON.stringify(parsed.data.identity) !== JSON.stringify(identity))
        throw new Error("chi-conversation-recovery-required");
      return saved as ClaimJournal;
    }
    if (selected.transfer.phase !== "reserved")
      throw new Error("chi-conversation-recovery-required");
    await reserveConversationReceipt(path);
    const journal: ClaimJournal = {
      identity,
      claim: {
        id: canonical.conversationId,
        revision: selected.conversation.revision,
        transferId: canonical.transferId,
        claimId: randomUUID(),
        destination,
      },
    };
    await writeConversationReceipt(path, journal);
    return journal;
  }

  private async publishFork(
    journal: ClaimJournal,
    path: string,
    client: ConversationClient,
    runtime: NativeRuntime,
    sessionId: string,
    snapshot: ManagedAgent,
  ) {
    const { id, transferId, claimId, destination } = journal.claim;
    const publicationPath = path.replace(/\.claim\.json$/, ".publication.json");
    let saved = await readConversationReceipt(publicationPath);
    if (saved === null) {
      const current = await client.get({ id, transferId });
      if (current.transfer?.phase !== "claimed" || current.transfer.claim?.id !== claimId)
        throw new Error("chi-conversation-recovery-required");
      const capture = prepareNativeCapture({
        sessionId,
        native: JSON.stringify(await runtime.export(sessionId)),
        mapping: destination,
        coverage: { kind: "export", reason: null },
      }).capture;
      const publication: PublishRequest = {
        id,
        revision: current.conversation.revision,
        transferId,
        claimId,
        capture,
      };
      await publishConversationReceipt(publicationPath, publication);
      // Always use the winner, including when another process published while
      // this process was exporting a now-advanced native history.
      saved = await readConversationReceipt(publicationPath);
    }
    const publication = z
      .object({
        id: z.literal(id),
        revision: z.number().int().positive(),
        transferId: z.literal(transferId),
        claimId: z.literal(claimId),
        capture: z.unknown(),
      })
      .parse(saved);
    // A complete visible winner may have been linked by a competing process
    // whose directory sync is still pending. Every publisher owns this barrier.
    await syncConversationReceiptDirectory(publicationPath);
    const result = await client.publish(publication);
    const published = result.transfer?.publication?.destination;
    if (!published || published.nativeSessionId !== sessionId)
      throw new Error("chi-conversation-invalid-response");
    const stale = result.conversation.current.sourceId !== published.sourceId;
    const association = await this.patchAssociation(snapshot.id, (current) => ({
      sourceId: published.sourceId,
      head: current.head ?? published.snapshotId,
      blocked:
        stale ||
        result.conversation.pending !== null ||
        (current.sourceId === published.sourceId && current.blocked === true),
    }));
    if (stale) await this.manager.archiveAgent(snapshot.id);
    else if (
      !result.conversation.pending &&
      association.error === "chi-conversation-publication-pending"
    )
      this.afterTurn(snapshot.id);
    return { conversationId: result.conversation.id, ...result.conversation.current };
  }

  async continue(
    input: ContinueSelection,
    registration: {
      find(sessionId: string): Promise<ManagedAgent | null>;
      register(
        sessionId: string,
        labels: Record<string, string>,
        chiRegistration?: object,
      ): Promise<ManagedAgent>;
    },
  ) {
    const canonical = input.canonical;
    if (!canonical?.conversationId || !canonical.transferId)
      throw new Error("chi-transfer-preparation-required");
    const key = createHash("sha256")
      .update(JSON.stringify([input.repo, canonical.conversationId, canonical.transferId]))
      .digest("hex");
    if (this.continuing.has(key)) throw new Error("chi-continuation-in-progress");
    this.continuing.add(key);
    try {
      const auth = await this.authorize(input.repo, input.cwd);
      const receipts = join(this.options.home, "chi", "receipts");
      await mkdir(receipts, { recursive: true, mode: 0o700 });
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))
        throw new Error("chi-invalid-request-id");
      const client = this.client(input.repo, auth.sessionToken);
      const destination = {
        instanceId: `${this.options.serverId}:opencode`,
        workspace: { hostId: this.options.serverId, path: input.cwd },
      };
      const journalPath = join(receipts, `${key}.claim.json`);
      const journal = await this.claimJournal(
        input,
        auth.chiUserId,
        client,
        destination,
        journalPath,
      );
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
          receipt: join(receipts, `${key}.json`),
          runtime,
          owner: {
            actor: auth.chiUserId,
            workspaceId: input.workspaceId,
            endpoint: this.authority.endpoint,
          },
        };
        const previous = await readContinuationReceipt(operation, this.authority.request);
        if (!previous) {
          const claimed = await client.claim(journal.claim);
          if (claimed.executionGranted !== true)
            throw new Error("chi-conversation-recovery-required");
        }
        const receipt = previous ?? (await continueNative(operation, this.authority.request));
        if (!receipt.destination.sessionId) throw new Error("chi-continuation-incomplete");
        const labels = {
          "chi.continuation": JSON.stringify({
            requestId: key,
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
            conversationId: canonical.conversationId,
            blocked: true,
          }),
        };
        const existing = await registration.find(receipt.destination.sessionId);
        if (existing) {
          assertRegistration(
            existing,
            input,
            receipt.destination.sessionId,
            labels["chi.continuation"],
          );
        }
        if (previous && !existing) await verifyContinuationReceipt(receipt, runtime);
        const permit = {};
        this.registrationPermits.set(permit, {
          sessionId: receipt.destination.sessionId,
          cwd: input.cwd,
          workspaceId: input.workspaceId,
          labels: JSON.stringify(labels),
        });
        let snapshot: ManagedAgent;
        try {
          snapshot =
            existing ??
            (await registration.register(receipt.destination.sessionId, labels, permit));
        } finally {
          this.registrationPermits.delete(permit);
        }
        const canonicalCurrent = await this.publishFork(
          journal,
          journalPath,
          client,
          runtime,
          receipt.destination.sessionId,
          snapshot,
        );
        return {
          sessionId: receipt.destination.sessionId,
          snapshot: this.manager.getAgent(snapshot.id) ?? snapshot,
          canonicalCurrent,
        };
      });
    } finally {
      this.continuing.delete(key);
    }
  }
}

export function safeChiError(error: unknown): string {
  if (error instanceof EvidenceHttpError && error.reason) return `${error.message}-${error.reason}`;
  if (error instanceof ContinuationError) return error.message;
  if (error instanceof Error && /^(?:chi|evidence|capture)-[a-z0-9-]+$/.test(error.message))
    return error.message;
  return "chi-operation-failed";
}
