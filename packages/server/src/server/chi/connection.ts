import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { raceProviderRefreshAbort } from "../agent/provider-refresh-deadline.js";
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
  nativeSourceExists,
  minimiseNativeExport,
  scanCaptureVerdict,
  type CaptureInput,
  type LocalScanInput,
  type LocalScanVerdict,
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
import { parseGitHubRemote } from "@henkaku-center/chi-native/repository";
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
import {
  HumanPrompts,
  HumanPromptSendError,
  quoteHumanAnswer,
  type HumanPromptOperation,
  type HumanPromptScope,
  type HumanPromptTransport,
} from "./human-prompts.js";
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
  destinationForEndpoint,
  type ChiDestinationsConfig,
  type ResolvedChiDestination,
} from "./destinations.js";
import {
  removeProvenance,
  writeProvenance,
  type ProvenanceRemover,
  type ProvenanceWriter,
} from "./provenance.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

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
  // Historical explicit Share/Continue labels used private visibility.
  explicit: z.boolean().optional(),
  // Hidden provenance ref written after a settled turn in a mapped workspace.
  provenanceRef: z.string().optional(),
  // Owner deletion outcome: whether the hidden ref was removed from the remote.
  provenanceRemoved: z.boolean().optional(),
  provenanceError: z.string().nullable().optional(),
  // Non-blocking capture warning (e.g. a secret only in minimised-away content).
  warning: z.string().nullable().optional(),
  promptEntryId: z.string().optional(),
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
function sameActor(a: string, b: string): boolean {
  // A GitHub login is case-insensitive to the backend; the label may hold the
  // login as typed by either the mention path (lowercased) or the capture path.
  return a.toLowerCase() === b.toLowerCase();
}
/** Secret rejections and cut-scan limits are terminal: never auto-retry.
 * A missing local scanner is retryable (install it and the next turn/reconnect retries). */
const TERMINAL_SYNC_ERRORS = new Set<string>([
  "capture-local-secret-rejected",
  "capture-local-cut-scan-limit",
  "evidence-http-422-server-secret-scan-rejected",
]);
function isTerminalSyncError(error: string | null | undefined): boolean {
  return typeof error === "string" && TERMINAL_SYNC_ERRORS.has(error);
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
const authSchema = z.object({
  ok: z.literal(true),
  chiUserId: z.string(),
  capabilities: z.object({ humanPrompts: z.boolean().optional() }).optional(),
});
const reposSchema = z.object({
  ok: z.literal(true),
  repos: z.array(z.object({ repo: z.string() })),
});

export interface ChiConnectionOptions {
  home: string;
  serverId: string;
  logger?: Pick<Logger, "warn">;
  authority?: ChiAuthority;
  /** Live daemon `chi` config; re-read on every resolution so reloads apply. */
  getChiConfig?: () => MutableChiConfig | undefined;
  /** Local full→minimised scan gate; defaults to the vendored verdict scanner. */
  scanCapture?: (full: LocalScanInput, minimised: LocalScanInput) => Promise<LocalScanVerdict>;
  /** Hidden provenance writer; defaults to the vendored chi-native writer. */
  provenance?: ProvenanceWriter;
  provenanceRemover?: ProvenanceRemover;
  /** Scanner binary forwarded to the default provenance writer (tests). */
  provenanceScanner?: string;
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
function createDeployment(endpoint: string): ChiAuthority {
  return {
    endpoint,
    request: fetch,
    ...createSessionLogin(readGitHubCliToken, (githubToken) =>
      exchangeGitHubToken({ githubToken, backendUrl: endpoint }),
    ),
  };
}

interface HumanPromptIdentityEntry {
  key: string;
  repo: string;
  expires: number;
  ready: boolean;
  cleared: boolean;
  pending: Promise<MentionIdentity>;
}
interface HumanPromptAccess {
  scope: HumanPromptScope;
  transport: HumanPromptTransport;
  check(fresh?: boolean): Promise<MentionIdentity>;
}
interface HumanPromptWorker {
  controller: AbortController;
  /** Whether this run finished its reconciliation reads. */
  done: Promise<boolean>;
  /** This run's access once its dispatch phase ends; `null` if it never got there. */
  dispatched: Promise<HumanPromptAccess | null>;
  rerun: boolean;
}

function mentionHttpStatus(error: unknown): number | null {
  const match = error instanceof Error ? /^chi-mentions-http-(\d{3})$/.exec(error.message) : null;
  return match ? Number(match[1]) : null;
}

function humanPromptFailure(error: unknown): string {
  return error instanceof Error && /^chi-[a-z0-9-]+$/.test(error.message)
    ? error.message
    : "chi-human-prompt-unavailable";
}

export class ChiConnection {
  readonly mentions: ChiMentions;
  private readonly humanPromptMentions: ChiMentions;
  readonly humanPrompts: HumanPrompts;
  isHumanPromptViewed: (agentId: string, recipient: string, owner: string) => boolean = () => false;
  private readonly participants = new ParticipantCache();
  private readonly registrationPermits = new WeakMap<
    object,
    { sessionId: string; cwd: string; workspaceId: string; labels: string }
  >();
  quarantinedSessions() {
    return readQuarantinedSessions(this.options.home, this.options.serverId);
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
    const stored = associationSchema.parse(JSON.parse(encoded));
    if (!stored.conversationId && !stored.blocked) return;
    const association = this.requireAssociation(stored);
    if (association.blocked) throw new Error("chi-conversation-pending");
    if (!association.conversationId) return;
    const endpoint = this.endpointFor(association.endpoint);
    const auth = await this.authorize(association.repo, agent.cwd, this.authorityFor(endpoint));
    if (!sameActor(auth.chiUserId, association.actor)) throw new Error("chi-identity-mismatch");
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
      association = this.requireAssociation(await this.reconcileAssociation(agentId, association));
      const endpoint = this.endpointFor(association.endpoint);
      const auth = await this.authorize(association.repo, agent.cwd, this.authorityFor(endpoint));
      if (!sameActor(auth.chiUserId, association.actor)) throw new Error("chi-identity-mismatch");
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
      const endpoint = this.requireAssociation(association).endpoint!;
      const auth = await this.authorize(association.repo, agent.cwd, this.authorityFor(endpoint));
      if (!sameActor(auth.chiUserId, association.actor)) throw new Error("chi-identity-mismatch");
      const client = this.client(association.repo, auth.sessionToken, endpoint);
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
  // Mention receipts are deployment-bound. Never retarget this transport on reload.
  private readonly primaryEndpoint: string | null;
  private get authority(): ChiAuthority {
    if (!this.primaryEndpoint) throw new Error("chi-destination-required");
    return this.authorityFor(this.endpointFor(this.primaryEndpoint));
  }
  private readonly scanCapture: (
    full: LocalScanInput,
    minimised: LocalScanInput,
  ) => Promise<LocalScanVerdict>;
  private readonly provenanceWriter: ProvenanceWriter;
  private readonly provenanceRemover: ProvenanceRemover;
  private readonly authorityByEndpoint = new Map<string, ChiAuthority>();
  // Status polls re-resolve the same cwd repeatedly; capture still re-reads the
  // remote. Cleared whenever the chi config reloads.
  private readonly originCache = new Map<string, string>();
  // Rotating cursor for the bounded startup provenance-orphan sweep, persisted
  // so a restart resumes rather than restarting the tail.
  private orphanSweepCursor = 0;
  private orphanBackoff: Record<string, { nextCheck: number; delay: number }> = {};
  private orphanCursorLoaded = false;
  private orphanSweepTimer: ReturnType<typeof setTimeout> | null = null;
  private orphanSweepStopped = true;
  constructor(
    private readonly manager: AgentManager,
    private readonly options: ChiConnectionOptions,
  ) {
    const endpoints = [
      ...new Set(Object.values(this.chiConfig()?.destinations ?? {}).map((d) => d.endpoint)),
    ];
    this.primaryEndpoint = endpoints.length === 1 ? endpoints[0]! : null;
    this.scanCapture =
      options.scanCapture ?? ((full, minimised) => scanCaptureVerdict(full, minimised));
    this.provenanceWriter = options.provenance ?? writeProvenance;
    this.provenanceRemover = options.provenanceRemover ?? removeProvenance;
    const getAuthority = () => this.authority;
    this.mentions = new ChiMentions(options.home, {
      get endpoint() {
        return getAuthority().endpoint;
      },
      request: async (url, init) => {
        const response = await this.authority.request(url, init);
        if ([401, 403, 404].includes(response.status)) {
          const repo = new Headers(init?.headers).get("x-chi-repo");
          this.loseMentionAuthority(
            response.status === 401 || !repo || repo === "*" ? undefined : { repo },
          );
        }
        return response;
      },
    });
    // Human prompts classify their own failures: a 404 for an unconfirmed batch
    // proves a lost create never landed and is not an access loss.
    this.humanPromptMentions = new ChiMentions(options.home, {
      get endpoint() {
        return getAuthority().endpoint;
      },
      request: (url, init) => this.authority.request(url, init),
    });
    this.humanPrompts = new HumanPrompts(options.home);
  }

  private chiConfig(): ChiDestinationsConfig | null {
    return parseChiDestinations(this.options.getChiConfig?.());
  }

  /** One authority per endpoint; an injected fixture authority overrides them all. */
  private authorityFor(endpoint: string): ChiAuthority {
    this.endpointFor(endpoint);
    const existing = this.authorityByEndpoint.get(endpoint);
    if (existing) return existing;
    const transport = this.options.authority ?? createDeployment(endpoint);
    const created: ChiAuthority = {
      endpoint,
      invalidate: () => transport.invalidate(),
      login: () => {
        this.endpointFor(endpoint);
        return transport.login();
      },
      request: (url, init) => {
        this.endpointFor(endpoint);
        return transport.request(url, init);
      },
    };
    this.authorityByEndpoint.set(endpoint, created);
    return created;
  }

  private async resolveForCwd(
    cwd: string,
    options: { cache?: boolean } = {},
  ): Promise<ResolvedChiDestination | null> {
    const config = this.chiConfig();
    if (!config) return null;
    const cached = options.cache ? this.originCache.get(cwd) : undefined;
    let origin: string | null | undefined = cached;
    if (origin === undefined) {
      try {
        const remote = await execCommand("git", ["remote", "get-url", "origin"], {
          cwd,
          timeout: 5000,
        });
        origin = remote.stdout;
      } catch {
        origin = null;
      }
      if (options.cache && origin) this.originCache.set(cwd, origin);
    }
    return origin ? resolveChiDestination(config, origin) : null;
  }

  private endpointFor(pinned?: string): string {
    if (!pinned || !destinationForEndpoint(this.chiConfig(), pinned))
      throw new Error("chi-destination-required");
    return pinned;
  }

  /** Without a scope the loss is host-wide; otherwise only that repository or checkout. */
  private loseMentionAuthority(scope?: { repo?: string; cwd?: string }) {
    this.participants.clear();
    this.clearHumanPromptAuthority(scope);
    for (const authority of this.authorityByEndpoint.values()) authority.invalidate();
  }

  private async mentionIdentity(cwd: string, directoryOnly = false): Promise<MentionIdentity> {
    let repo: string | undefined;
    try {
      const remote = await execCommand("git", ["remote", "get-url", "origin"], {
        cwd,
        timeout: 5000,
      });
      const parsed = parseGitHubRemote(remote.stdout);
      if (!parsed) throw new Error("chi-repository-mismatch");
      repo = `github:${parsed.owner}/${parsed.repo}`.toLowerCase();
      const resolved = resolveChiDestinationForRepo(this.chiConfig(), repo);
      if (!resolved) throw new Error("chi-destination-required");
      if (resolved.endpoint !== this.authority.endpoint)
        throw new Error("chi-mentions-unavailable");
      const auth = directoryOnly ? await this.authority.login() : await this.authorize(repo, cwd);
      return {
        repo,
        actor: auth.chiUserId.toLowerCase(),
        token: auth.sessionToken,
        credentialGeneration: auth.credentialGeneration,
        humanPrompts: "humanPrompts" in auth && auth.humanPrompts === true,
      };
    } catch (error) {
      this.loseMentionAuthority(repo ? { repo } : { cwd });
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
    // A peer destination cannot deliver mentions; fail before preparing one that
    // could never be reconciled.
    association = this.requireAssociation(await this.reconcileAssociation(agentId, association));
    if (association.endpoint !== this.authority.endpoint)
      throw new Error("chi-mentions-unavailable");
    if (!association.actor) {
      // An auto-association may be created without an actor; bind it now rather
      // than rejecting the first mention in that window.
      association = await this.patchAssociation(agentId, { actor: identity.actor });
    } else if (
      identity.actor !== association.actor.toLowerCase() ||
      identity.repo !== association.repo.toLowerCase()
    ) {
      throw new Error("chi-identity-mismatch");
    }
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

  private readonly humanPromptIdentities = new Map<string, HumanPromptIdentityEntry>();
  private humanPromptCredential: string | null = null;
  // Advanced only by host-wide clears: credential change, reload and shutdown.
  private humanPromptEpoch = 0;

  /** Without a scope the clear is host-wide; otherwise only that repository or checkout. */
  private clearHumanPromptAuthority(scope?: { repo?: string; cwd?: string }) {
    if (!scope) {
      this.humanPromptEpoch++;
      this.humanPromptCredential = null;
    }
    const repo = scope?.repo?.toLowerCase();
    for (const [cwd, entry] of this.humanPromptIdentities) {
      if (scope && entry.repo !== repo && cwd !== scope.cwd) continue;
      // Callers still awaiting this acquisition must not use its delayed result.
      entry.cleared = true;
      this.humanPromptIdentities.delete(cwd);
    }
  }

  private async humanPromptIdentity(cwd: string, fresh: boolean) {
    // login() checks the host credential on every access. Never cache logout,
    // credential rotation or the live Git remote behind the repository TTL.
    const epoch = this.humanPromptEpoch;
    const observed = await this.mentionIdentity(cwd, true);
    if (epoch !== this.humanPromptEpoch) throw new Error("chi-human-prompt-context-changed");
    const credential = JSON.stringify([
      observed.actor,
      observed.credentialGeneration ?? observed.token,
    ]);
    if (this.humanPromptCredential !== null && this.humanPromptCredential !== credential)
      this.clearHumanPromptAuthority();
    this.humanPromptCredential = credential;
    // A reminted session token replaces only this checkout's entry.
    const key = JSON.stringify([this.mentionContext(observed), observed.token]);
    let entry = this.humanPromptIdentities.get(cwd);
    if (!entry || entry.key !== key || (entry.ready && (fresh || entry.expires <= Date.now()))) {
      for (const [path, cached] of this.humanPromptIdentities)
        if (cached.ready && cached.expires <= Date.now()) this.humanPromptIdentities.delete(path);
      if (this.humanPromptIdentities.size >= 64)
        this.humanPromptIdentities.delete(this.humanPromptIdentities.keys().next().value!);
      const next: HumanPromptIdentityEntry = {
        key,
        repo: observed.repo,
        expires: Date.now() + 30_000,
        ready: false,
        cleared: false,
        pending: Promise.resolve().then(async () => {
          try {
            const identity = await this.mentionIdentity(cwd);
            next.ready = true;
            next.expires = Date.now() + 30_000;
            return identity;
          } catch (error) {
            // Never cache a rejection, even when the failure cleared another scope.
            if (this.humanPromptIdentities.get(cwd) === next)
              this.humanPromptIdentities.delete(cwd);
            throw error;
          }
        }),
      };
      entry = next;
      this.humanPromptIdentities.set(cwd, entry);
    }
    // A context mismatch means the credential changed, which the next access clears.
    const current = entry;
    const identity = await current.pending;
    if (current.cleared) throw new Error("chi-human-prompt-context-changed");
    this.requireMentionContext(identity, this.mentionContext(observed));
    // A backend upgrade should become available on the next boundary.
    if (!identity.humanPrompts && this.humanPromptIdentities.get(cwd) === current)
      this.humanPromptIdentities.delete(cwd);
    return identity;
  }

  private humanPromptBinding(agentId: string) {
    const agent = this.manager.getAgent(agentId);
    if (!agent || agent.provider !== "opencode") throw new Error("chi-native-agent-required");
    const association = this.association(agent);
    // Capture/provenance progress can advance while a detached boundary waits.
    // Bind authority, not the mutable capture head or error/status labels.
    return JSON.stringify([
      agent.cwd,
      agent.persistence?.nativeHandle ?? agent.persistence?.sessionId,
      association && [
        association.repo,
        association.actor,
        association.endpoint,
        association.destination,
        association.audience,
        association.paused,
        association.blocked,
        association.conversationId,
        association.conversationId && association.sourceId,
      ],
      this.chiConfig(),
    ]);
  }

  // Failures here concern one agent; they never clear another agent's authority.
  private async humanPromptAuthority(agentId: string, fresh = false) {
    const agent = this.manager.getAgent(agentId);
    if (!agent || !agent.persistence || !agent.session?.humanPromptTurnId)
      throw new Error("chi-native-agent-required");
    const binding = this.humanPromptBinding(agentId);
    const mapping = await this.resolveForCwd(agent.cwd);
    const association = this.association(agent);
    if (
      !mapping ||
      !association ||
      association.paused ||
      association.blocked ||
      mapping.endpoint !== this.primaryEndpoint ||
      this.endpointFor(association.endpoint) !== mapping.endpoint
    )
      throw new Error("chi-human-prompt-mapping-required");
    const identity = await this.humanPromptIdentity(agent.cwd, fresh);
    if (
      association.repo.toLowerCase() !== identity.repo ||
      association.actor.toLowerCase() !== identity.actor
    )
      throw new Error("chi-human-prompt-mapping-required");
    await this.assertCurrent(agent);
    const sessionId = agent.persistence.nativeHandle ?? agent.persistence.sessionId;
    if (!sessionId) throw new Error("chi-native-agent-required");
    const turnId = await agent.session.humanPromptTurnId();
    if (!turnId) throw new Error("chi-human-prompt-native-turn-required");
    if (this.humanPromptBinding(agentId) !== binding)
      throw new Error("chi-human-prompt-context-changed");
    const scope = {
      agentId,
      sessionId,
      turnId,
      context: this.mentionContext(identity),
      pendingQuestionIds: [...agent.pendingPermissions.values()]
        .filter((r) => this.isRoutableHumanQuestion(r) && r.metadata.sessionId === sessionId)
        .map((r) => r.id),
    };
    return { scope, identity, association };
  }

  private async humanPromptAccess(agentId: string, signal?: AbortSignal) {
    const initial = await raceProviderRefreshAbort(signal, this.humanPromptAuthority(agentId));
    signal?.throwIfAborted();
    // Only this agent's own session, identity or mapping aborts its work. A
    // cleared cache means the next check reacquires authority, not a lockout.
    const check = async (fresh = false) => {
      signal?.throwIfAborted();
      const current = await raceProviderRefreshAbort(
        signal,
        this.humanPromptAuthority(agentId, fresh),
      );
      signal?.throwIfAborted();
      if (current.scope.sessionId !== initial.scope.sessionId)
        throw new Error("chi-human-prompt-context-changed");
      this.requireMentionContext(current.identity, initial.scope.context);
      return current.identity;
    };
    const repo = initial.identity.repo;
    const transport: HumanPromptTransport = {
      signal,
      dispatchEnabled: initial.identity.humanPrompts === true,
      viewed: (recipient: string) =>
        this.isHumanPromptViewed(agentId, recipient, initial.identity.actor),
      create: async (batch) => {
        let current: MentionIdentity;
        try {
          signal?.throwIfAborted();
          // Reads share the boundary bracket; a write needs fresh admission after
          // any awaited reads, as well as verification after the response.
          current = await check(true);
          if (!current.humanPrompts) throw new Error("chi-human-prompts-backend-upgrade-required");
          // Viewing can begin during slow admission. Nothing is posted then.
          if (this.isHumanPromptViewed(agentId, batch.recipient, current.actor))
            throw new Error("chi-human-prompt-viewed");
        } catch (error) {
          throw new HumanPromptSendError(humanPromptFailure(error), "not-sent");
        }
        let result;
        try {
          result = await this.humanPromptMentions.createHandoff(current, batch);
        } catch (error) {
          const status = mentionHttpStatus(error);
          // As for every other mention write, a denial drops cached authority.
          if (status === 401) this.loseMentionAuthority();
          else if (status === 403 || status === 404) this.loseMentionAuthority({ repo });
          // Authentication and repository denials precede the handler; the other
          // fixed client errors prove that the backend refused this create.
          if (status === 401 || status === 403)
            throw new HumanPromptSendError(humanPromptFailure(error), "not-sent");
          if (status !== null && [400, 404, 409, 413, 422].includes(status))
            throw new HumanPromptSendError(humanPromptFailure(error), "rejected");
          throw error;
        }
        await check();
        return result;
      },
      read: async (id, unconfirmed = false) => {
        signal?.throwIfAborted();
        let result;
        try {
          result = await this.humanPromptMentions.execute(initial.identity, {
            action: "read",
            id,
          });
        } catch (error) {
          const status = mentionHttpStatus(error);
          // The author's own unconfirmed batch is absent: its create never landed.
          if (status === 404 && unconfirmed) return null;
          if (status === 401) this.loseMentionAuthority();
          else if (status === 403 || status === 404) this.loseMentionAuthority({ repo });
          throw error;
        }
        if (result.kind !== "handoff") throw new Error("chi-human-prompt-invalid-response");
        return result.handoff;
      },
    };
    return { ...initial, transport, check };
  }

  async humanPromptOperation(agentId: string, operation: HumanPromptOperation) {
    const access = await this.humanPromptAccess(agentId);
    const result = await this.humanPrompts.operate(access.scope, operation, access.transport);
    await access.check();
    for (const item of result.items) {
      if (!item.answer) continue;
      Object.assign(item.answer, {
        actor: item.answer.actor ?? item.recipient,
        trust: "untrusted human-written data",
        text: quoteHumanAnswer(item.answer.text),
      });
    }
    return result;
  }

  private humanPromptSource(association: Association) {
    return association.sourceId && association.head && association.promptEntryId
      ? {
          kind: "neutral" as const,
          id: association.sourceId,
          snapshot: association.head,
          entryId: association.promptEntryId,
        }
      : null;
  }

  private readonly humanPromptBoundaries = new Map<string, HumanPromptWorker>();

  async humanPromptBoundary(agentId: string, remind = true): Promise<string | null> {
    const worker = this.humanPromptWorker(agentId);
    if (!remind) return worker.done.then(() => null);
    // Only the wait belongs to the foreground turn. The coalesced worker keeps
    // dispatching and persisting read progress across subsequent turn starts.
    const budget = new AbortController();
    const timer = setTimeout(() => {
      this.options.logger?.warn(
        { agentId, reason: "foreground-budget" },
        "Chi human prompt boundary wait timed out",
      );
      budget.abort("foreground-budget");
    }, 2000);
    try {
      return await this.humanPromptReminder(agentId, worker, budget.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One detached dispatch and reconciliation per agent; later requests coalesce. */
  private humanPromptWorker(agentId: string): HumanPromptWorker {
    const existing = this.humanPromptBoundaries.get(agentId);
    if (existing && !existing.controller.signal.aborted) {
      // A turn can queue more items after this worker's dispatch phase.
      // Coalescing that boundary must not lose its request to drain them.
      existing.rerun = true;
      return existing;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("background-timeout"), 120_000);
    timer.unref();
    const cwd = this.manager.getAgent(agentId)?.cwd;
    controller.signal.addEventListener(
      "abort",
      () => {
        // A stalled acquisition must not become an immortal pending entry that
        // every later turn joins after this worker times out.
        const entry = cwd === undefined ? undefined : this.humanPromptIdentities.get(cwd);
        if (controller.signal.reason === "background-timeout" && entry && !entry.ready)
          this.clearHumanPromptAuthority({ cwd });
        this.options.logger?.warn(
          { agentId, reason: controller.signal.reason },
          "Chi human prompt boundary aborted",
        );
      },
      { once: true },
    );
    let publish!: (access: HumanPromptAccess | null) => void;
    const worker: HumanPromptWorker = {
      controller,
      rerun: false,
      dispatched: new Promise((resolve) => {
        publish = resolve;
      }),
      done: Promise.resolve(false),
    };
    worker.done = this.humanPromptWork(agentId, controller.signal, publish).finally(() => {
      clearTimeout(timer);
      publish(null);
      if (this.humanPromptBoundaries.get(agentId) !== worker) return;
      this.humanPromptBoundaries.delete(agentId);
      if (worker.rerun && !controller.signal.aborted) void this.humanPromptWorker(agentId);
    });
    this.humanPromptBoundaries.set(agentId, worker);
    return worker;
  }

  private async humanPromptWork(
    agentId: string,
    signal: AbortSignal,
    publish: (access: HumanPromptAccess) => void,
  ): Promise<boolean> {
    try {
      if (!(await this.humanPrompts.hasItems(agentId))) return false;
      const access = await this.humanPromptAccess(agentId, signal);
      await this.humanPrompts.dispatch(access.scope, access.transport, {
        source: this.humanPromptSource(access.association),
        viewed: false,
      });
      publish(access);
      // The worker owns its reads, so the deadline, shutdown and close abort them.
      await this.humanPrompts.refresh(access.scope, access.transport);
      return true;
    } catch (error) {
      this.logHumanPromptFailure(agentId, signal, error);
      return false;
    }
  }

  /** Any turn start, including one that joins an after-turn worker, gets its reminder. */
  private async humanPromptReminder(
    agentId: string,
    worker: HumanPromptWorker,
    budget: AbortSignal,
  ) {
    // Every step settles at the foreground budget; the worker keeps the progress.
    const within = <T>(operation: Promise<T>) => raceProviderRefreshAbort(budget, operation);
    try {
      const access = await within(worker.dispatched);
      if (!access) return null;
      // Cached answers need not wait for this worker's reads; they are still
      // re-verified against the backend before exposure.
      let reminder = await within(this.humanPrompts.reminder(access.scope, access.transport, true));
      if (reminder === null) {
        // A failed reconciliation withholds the reminder rather than exposing
        // statuses it could not confirm.
        if (!(await within(worker.done))) return null;
        reminder = await within(this.humanPrompts.reminder(access.scope, access.transport));
      }
      await within(access.check());
      return reminder;
    } catch (error) {
      if (!budget.aborted) this.logHumanPromptFailure(agentId, worker.controller.signal, error);
      // A segment failure withholds data and never blocks an unrelated model turn.
      return null;
    }
  }

  private logHumanPromptFailure(agentId: string, signal: AbortSignal, error: unknown) {
    if (signal.aborted) return;
    let reason = "boundary-failed";
    if (error instanceof Error) {
      if (error.name === "AbortError") reason = "request-aborted";
      if (error.name === "TimeoutError") reason = "request-timeout";
    }
    this.options.logger?.warn({ agentId, reason }, "Chi human prompt boundary withheld");
  }

  /** Archive, close and reload end that agent's detached human-prompt work. */
  agentClosed(agentId: string) {
    this.humanPromptBoundaries.get(agentId)?.controller.abort("agent-closed");
  }

  private readonly questionLanes = new Set<string>();
  private isRoutableHumanQuestion(request: {
    kind?: string;
    metadata?: Record<string, unknown>;
  }): request is { kind: "question"; metadata: Record<string, unknown> } {
    const metadata = request.metadata;
    return (
      request.kind === "question" &&
      metadata?.source === "opencode_question" &&
      metadata.formKind === "question" &&
      z.object({ messageID: z.string().min(1), id: z.string().min(1) }).safeParse(metadata.tool)
        .success
    );
  }
  async acknowledgeHumanPromptReminder(agentId: string, rendered: string) {
    const { scope } = await this.humanPromptAccess(agentId);
    await this.humanPrompts.acknowledgeReminder(scope, rendered);
  }
  async reconcileHumanQuestions(agentId: string): Promise<void> {
    if (this.questionLanes.has(agentId)) return;
    this.questionLanes.add(agentId);
    try {
      const agent = this.manager.getAgent(agentId);
      if (!agent || agent.provider !== "opencode") return;
      const requests = [...agent.pendingPermissions.values()].filter((r) =>
        this.isRoutableHumanQuestion(r),
      );
      if (!requests.length) return;
      const access = await this.humanPromptAccess(agentId);
      const forms = requests
        .filter((request) => request.metadata?.sessionId === access.scope.sessionId)
        .map((request) => {
          const questions = z
            .array(
              z.object({
                header: z.string().min(1),
                question: z.string().min(1),
                options: z.array(z.unknown()),
                multiSelect: z.boolean().optional(),
              }),
            )
            .min(1)
            .max(5)
            .parse(request.input?.questions);
          return {
            request,
            questions,
            keys: questions.map((_, index) => `question/${request.id}/${index}`),
          };
        });
      if (!forms.length) return;
      for (const { request, questions, keys } of forms) {
        for (const [index, question] of questions.entries()) {
          await this.humanPrompts.operate(
            access.scope,
            {
              action: "add",
              dedupeKey: keys[index]!,
              recipient: access.identity.actor,
              kind: "question",
              priority: "blocking",
              text: `${question.question}\nOptions: ${JSON.stringify(question.options)}${question.multiSelect ? "\nAnswer with a JSON array of selected labels." : ""}`,
            },
            access.transport,
            { nativeQuestionId: request.id, verified: new Set() },
          );
        }
      }
      await this.humanPrompts.dispatch(access.scope, access.transport, {
        source: this.humanPromptSource(access.association),
        viewed: false,
      });
      // Only answers whose handoffs this pass read can resume a form.
      const verified = await this.humanPrompts.refresh(access.scope, access.transport);
      const result = await this.humanPrompts.operate(
        access.scope,
        { action: "resolve" },
        access.transport,
        { verified },
      );
      await access.check();
      for (const { request, questions, keys } of forms) {
        const items = keys.map((key) =>
          result.items.find(
            (item) => item.dedupeKey === key && item.recipient === access.identity.actor,
          ),
        );
        if (!items.every((item) => item?.answer)) continue;
        const answers: Record<string, string | string[]> = Object.create(null);
        for (const [index, question] of questions.entries()) {
          const answer = items[index]!.answer!;
          const text = answer.text;
          const quoted = (value: string) =>
            `Untrusted human-written data from ${answer.actor ?? items[index]!.recipient}: ${quoteHumanAnswer(value)}`;
          answers[question.header] = question.multiSelect
            ? z.array(z.string()).parse(JSON.parse(text)).map(quoted)
            : quoted(text);
        }
        if (this.manager.getAgent(agentId)?.pendingPermissions.get(request.id) !== request)
          continue;
        // Reply resumes this waiting form's next model step. No new/steer prompt
        // and no runtime permission approval is synthesized from human prose.
        await this.manager.respondToPermission(agentId, request.id, {
          behavior: "allow",
          updatedInput: { answers },
        });
      }
    } finally {
      this.questionLanes.delete(agentId);
    }
  }

  private humanPromptTimer: ReturnType<typeof setTimeout> | null = null;
  private humanPromptStopped = true;
  startHumanPromptSweep() {
    if (!this.humanPromptStopped) return;
    this.humanPromptStopped = false;
    const sweep = async () => {
      try {
        for (const agent of this.manager.listAgents()) {
          if (this.humanPromptStopped) break;
          await this.reconcileHumanQuestions(agent.id).catch(() => undefined);
        }
      } finally {
        if (!this.humanPromptStopped) {
          this.humanPromptTimer = setTimeout(() => void sweep(), 30000);
          this.humanPromptTimer.unref();
        }
      }
    };
    void sweep();
  }
  stopHumanPromptSweep() {
    this.humanPromptStopped = true;
    if (this.humanPromptTimer) clearTimeout(this.humanPromptTimer);
    this.humanPromptTimer = null;
    for (const work of this.humanPromptBoundaries.values()) work.controller.abort("stopped");
    this.clearHumanPromptAuthority();
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
      return await this.authorizeRepository(repo, cwd, authority);
    } catch (error) {
      if (classifyMentionFailure(error).accessLost) this.loseMentionAuthority({ repo });
      throw error;
    }
  }

  private async authorizeRepository(repo: string, cwd: string, authority: ChiAuthority) {
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
    if (!catalog.repos.some((entry) => entry.repo.toLowerCase() === repo.toLowerCase()))
      throw new Error("chi-repository-denied");
    return { ...session, humanPrompts: identity.capabilities?.humanPrompts === true };
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
    const repo = (selectedRepo ?? `github:${parsed.owner}/${parsed.repo}`).toLowerCase();
    const resolved = resolveChiDestinationForRepo(this.chiConfig(), repo);
    if (!resolved) throw new Error("chi-destination-required");
    const endpoint = resolved.endpoint;
    const auth = await this.authorize(repo, agent.cwd, this.authorityFor(endpoint));
    const encoded = await this.manager.updateAgentLabel(agentId, label, (current) => {
      if (current) {
        const previous = associationSchema.parse(JSON.parse(current));
        if (previous.repo.toLowerCase() !== repo) throw new Error("chi-association-conflict");
        if (!sameActor(previous.actor, auth.chiUserId)) throw new Error("chi-identity-mismatch");
        return current;
      }
      return JSON.stringify({
        repo,
        actor: auth.chiUserId,
        sourceId: null,
        head: null,
        error: null,
        destination: resolved.destinationId,
        endpoint: resolved.endpoint,
        audience: resolved.audience,
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
      const endpoint = this.endpointFor(association.endpoint);
      const authority = this.authorityFor(endpoint);
      const auth = await this.authorize(association.repo, target.cwd, authority);
      if (!association.actor) {
        association = await this.patchAssociation(agentId, { actor: auth.chiUserId });
      } else if (!sameActor(auth.chiUserId, association.actor)) {
        throw new Error("chi-identity-mismatch");
      }
      const pinned: Association = association;
      await this.patchAssociation(agentId, { capturePending: true });
      const sessionId = target.persistence.nativeHandle ?? target.persistence.sessionId;
      if (!sessionId) throw new Error("chi-native-agent-required");
      const settled = await this.manager.withNativeRuntime(sessionId, async (runtime) => {
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
        const mapping = {
          instanceId: `${this.options.serverId}:opencode`,
          workspace: { hostId: this.options.serverId, path: target.cwd },
        };
        const coverage = { kind: "export" as const, reason: null };
        const gitCoordinate = await this.captureGitCoordinate(target.cwd);
        const minimised = minimiseNativeExport({
          native,
          mapping,
          coverage,
          sessionId,
          ...(gitCoordinate ? { git: gitCoordinate } : {}),
        }).capture;
        const input = {
          endpoint,
          token: auth.sessionToken,
          repo: pinned.repo,
          sessionId,
          mapping,
          expectedHead: pinned.head,
          visibility: pinned.audience ?? (pinned.explicit ? "private" : "shared"),
          coverage,
          capture: minimised,
        };
        const { parsed, captured, captureError, warning } = await this.scanAndCapture({
          input,
          full: { native, mapping, coverage, sessionId },
          minimised: {
            native: minimised.native,
            mapping,
            coverage,
            sessionId,
            projection: minimised.projection,
            ...(minimised.git ? { git: minimised.git } : {}),
          },
          retryConflict,
          ownerId: auth.chiUserId,
          request: authority.request,
        });
        if (!captured) {
          if (warning) {
            await this.patchAssociation(agentId, { warning }).catch(() => undefined);
          }
          return { parsed, captured: null, captureError, updated: null };
        }
        const updated = await this.patchAssociation(agentId, {
          sourceId: captured.sourceId,
          head: captured.head,
          error: null,
          capturePending: false,
          warning,
          promptEntryId: parsed.entries.at(-1)?.nativeId,
        });
        // Mentions stay on the primary deployment; a peer destination's mentions
        // are out of P1 scope and are never cross-posted.
        if (endpoint === this.primaryEndpoint) {
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
        return { parsed, captured, captureError, updated };
      });
      return await this.finishCapture(settled, pinned, auth.chiUserId, sessionId, target, agentId);
    } catch (error) {
      const code = safeChiError(error);
      // Owner deletion: the backend fences the deleted source with
      // `object-deleted`; the daemon holds the user's git credentials, so it
      // removes the matching hidden provenance refs best-effort.
      if (code.endsWith("object-deleted")) {
        void this.purgeProvenance(agentId, target, association).catch(() => undefined);
      }
      // A terminal secret-scan rejection must not be retried automatically and
      // must not be persisted as a durable capture-needed state.
      if (isTerminalSyncError(code)) {
        await this.patchAssociation(agentId, { error: code, capturePending: false });
      } else if (code !== "chi-session-busy") {
        // Busy is transient (the capture loop retries); never persist it as a durable
        // sync error, which startup reconciliation would otherwise surface forever.
        await this.patchAssociation(agentId, { error: code, capturePending: true });
      }
      throw new Error(code, { cause: error });
    }
  }

  /**
   * Bind a pre-P1 association to its configured destination, or pause it when the
   * repository no longer maps or the pinned endpoint changed. Pausing never moves
   * data. Canonical continuation prompts still require an active destination.
   */
  private async reconcileAssociation(
    agentId: string,
    association: Association,
  ): Promise<Association> {
    const resolved = this.resolveAssociation(association);
    if (JSON.stringify(resolved) === JSON.stringify(association)) return association;
    return this.patchAssociation(agentId, (current) => this.resolveAssociation(current));
  }

  private requireAssociation(association: Association): Association {
    const resolved = this.resolveAssociation(association);
    if (resolved.paused) throw new Error(resolved.error ?? "chi-destination-required");
    return resolved;
  }

  private resolveAssociation(association: Association): Association {
    const config = this.chiConfig();
    const paused = (error: string): Association => ({
      ...association,
      paused: true,
      capturePending: false,
      error,
    });
    if (association.destination) {
      const configured = config?.destinations[association.destination];
      if (!configured || configured.endpoint !== association.endpoint)
        return paused("chi-destination-changed");
      if (association.paused)
        // The pinned destination is configured again: resume the durable capture.
        return { ...association, paused: false, capturePending: true, error: null };
      return association;
    }
    // COMPAT(chi-pre-destinations): migration only, added 2026-10-01. Retain until
    // pre-P1 persisted labels have been migrated; this URL never authorizes I/O.
    const oldEndpoint = association.endpoint ?? "https://chi-backend-vadmp23swa-an.a.run.app";
    const mapping = resolveChiDestinationForRepo(config, association.repo);
    if (!association.explicit && (!mapping || mapping.endpoint !== oldEndpoint))
      return paused("chi-destination-unmapped");
    const resolved = association.explicit
      ? destinationForEndpoint(config, oldEndpoint)
      : { id: mapping!.destinationId, endpoint: mapping!.endpoint };
    if (!resolved) return paused("chi-destination-required");
    return {
      ...association,
      destination: resolved.id,
      endpoint: resolved.endpoint,
      audience: association.explicit ? "private" : (association.audience ?? mapping!.audience),
      paused: false,
      error: association.paused ? null : association.error,
    };
  }

  /**
   * Runs after the native runtime is released: best-effort provenance write (a
   * purged `object-deleted` source must not be re-created), then surface the
   * capture result or error.
   */
  private async finishCapture(
    settled: {
      parsed: ReturnType<typeof prepareNativeCapture>;
      captured: Awaited<ReturnType<typeof captureNative>> | null;
      captureError: unknown;
      updated: Association | null;
    },
    association: Association,
    user: string,
    sessionId: string,
    target: CaptureTarget,
    agentId: string,
  ): Promise<Association> {
    const deleted = safeChiError(settled.captureError).endsWith("object-deleted");
    const mapping = resolveChiDestinationForRepo(this.chiConfig(), association.repo);
    if (
      association.destination &&
      !association.paused &&
      !deleted &&
      mapping?.endpoint === association.endpoint
    ) {
      await this.writeProvenanceFor(
        target,
        association,
        user,
        sessionId,
        settled.parsed,
        settled.captured,
        agentId,
      );
    }
    if (settled.captureError) throw settled.captureError;
    if (!settled.updated) throw new Error("capture-incomplete");
    return settled.updated;
  }

  /**
   * Exact-upload scan followed by full-export attribution. A finding in uploaded
   * content blocks (`capture-local-secret-rejected`); a finding only in omitted
   * content records a non-blocking warning and syncs. Missing scanner fails
   * closed. The server scan remains the authority.
   */
  private async scanAndCapture(args: {
    input: CaptureInput;
    full: LocalScanInput;
    minimised: LocalScanInput;
    retryConflict: boolean;
    ownerId: string;
    request: typeof fetch;
  }): Promise<{
    parsed: ReturnType<typeof prepareNativeCapture>;
    captured: Awaited<ReturnType<typeof captureNative>> | null;
    captureError: unknown;
    warning: string | null;
  }> {
    const parsed = prepareNativeCapture(args.input);
    let captured: Awaited<ReturnType<typeof captureNative>> | null = null;
    let captureError: unknown = null;
    let warning: string | null = null;
    try {
      const verdict = await this.scanCapture(args.full, args.minimised);
      if (verdict.verdict === "omitted-warning") warning = "capture-local-secret-omitted-content";
      if (verdict.verdict === "attribution-unavailable")
        warning = "capture-local-attribution-unavailable";
      captured = await (args.retryConflict
        ? retryCaptureNative(args.input, args.ownerId, args.request)
        : captureNative(args.input, args.request));
    } catch (error) {
      captureError = error;
    }
    return { parsed, captured, captureError, warning };
  }

  /** Repository coordinate for a v2 capture; best-effort, absent off a branch. */
  private async captureGitCoordinate(
    cwd: string,
  ): Promise<{ branch: string; commit: string } | null> {
    try {
      const branch = (
        await execCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 })
      ).stdout.trim();
      const commit = (
        await execCommand("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 5000 })
      ).stdout.trim();
      if (!branch || branch === "HEAD" || !/^[a-f0-9]{7,64}$/.test(commit)) return null;
      return { branch, commit };
    } catch {
      return null;
    }
  }

  /** A delegated agent's parent session, for `origin: delegation`. */
  private delegationFor(target: CaptureTarget): { parentSessionId: string } | null {
    const parentId = target.labels[PARENT_AGENT_ID_LABEL];
    if (!parentId) return null;
    const parent = this.manager.getAgent(parentId);
    const sessionId =
      parent?.persistence?.nativeHandle ?? parent?.persistence?.sessionId ?? parentId;
    return { parentSessionId: sessionId };
  }

  /**
   * Async, best-effort hidden-ref write. The bounded reason is persisted so a
   * skipped or failed snapshot is visible on the association instead of silent.
   */
  private async writeProvenanceFor(
    target: CaptureTarget,
    association: Association,
    user: string,
    sessionId: string,
    parsed: ReturnType<typeof prepareNativeCapture>,
    captured: { sourceId: string; head: string } | null,
    agentId: string,
  ): Promise<void> {
    try {
      const outcome = await this.provenanceWriter({
        root: target.cwd,
        user,
        sessionId,
        repo: association.repo,
        sourceId: captured?.sourceId ?? association.sourceId,
        head: captured?.head ?? association.head,
        evidence: parsed,
        continuation: Boolean(target.labels["chi.continuation"]),
        delegation: this.delegationFor(target),
        ...(this.options.provenanceScanner ? { scanner: this.options.provenanceScanner } : {}),
      });
      const noop = outcome.reason === "worktree-clean" || outcome.reason === "snapshot-unchanged";
      const clean = noop || (outcome.created && outcome.pushReason === "pushed");
      await this.patchAssociation(agentId, {
        provenanceRef: outcome.ref,
        provenanceError: clean ? null : outcome.reason,
      });
    } catch {
      await this.patchAssociation(agentId, { provenanceError: "provenance-failed" }).catch(
        () => undefined,
      );
    }
  }

  /** Best-effort owner-deletion sweep for the source's hidden provenance ref. */
  private async purgeProvenance(
    agentId: string,
    target: CaptureTarget,
    association: Association,
  ): Promise<void> {
    const sessionId = target.persistence.nativeHandle ?? target.persistence.sessionId;
    if (!sessionId || !association.actor) return;
    try {
      const outcome = await this.provenanceRemover({
        root: target.cwd,
        user: association.actor,
        sessionId,
        ...(association.provenanceRef ? { ref: association.provenanceRef } : {}),
      });
      await this.patchAssociation(agentId, {
        provenanceRemoved: outcome.removed,
        provenanceError: outcome.removed ? null : outcome.reason,
      });
    } catch {
      // Deletion is best-effort; a failed sweep retries on the next capture attempt.
    }
  }

  afterTurn(agentId: string): void {
    const agent = this.manager.getAgent(agentId);
    if (!agent || agent.provider !== "opencode") return;
    const association = this.association(agent);
    // A genuine secret-scan rejection is terminal until the user retries.
    if (association && isTerminalSyncError(association.error)) return;
    // A genuinely local workspace (no mapping at all) stays quiet.
    if (!association && !this.chiConfig()) return;
    // Capture runs after manager turn reconciliation; the pending map coalesces
    // duplicate lifecycle notifications without polling or a second process.
    queueMicrotask(() => {
      void this.capture(agentId)
        .catch(() => undefined)
        .then(() => this.humanPromptBoundary(agentId, false))
        .catch(() => undefined);
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
    this.originCache.clear();
    this.clearHumanPromptAuthority();
    for (const work of this.humanPromptBoundaries.values())
      work.controller.abort("destinations-changed");
    for (const candidate of await this.candidateLabels()) {
      if (!candidate.labels[label]) continue;
      void this.capture(candidate.id).catch(() => undefined);
    }
  }

  /** Retry captures that are outstanding across a restart or reconnect. */
  async reconcilePending(): Promise<void> {
    for (const candidate of await this.candidateLabels()) {
      const association = this.parseAssociation(candidate.labels[label]);
      if (
        !association ||
        association.paused ||
        !association.capturePending ||
        isTerminalSyncError(association.error)
      )
        continue;
      void this.capture(candidate.id).catch(() => undefined);
    }
  }

  /**
   * Owner deletion reaches refs only when the association still exists and a
   * capture re-attempts. A source deleted after the agent is archived (or the
   * workspace removed) would orphan its ref forever. At daemon bootstrap, verify
   * stored associations with a hidden ref and purge the ones the backend reports
   * gone explicitly. Bounded, quiet, and rotating so the tail is not starved.
   */
  async reconcileProvenanceOrphans(): Promise<void> {
    const records = [...((await this.options.listStoredAgents?.()) ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    this.loadOrphanCursor();
    const ids = new Set(records.map((record) => record.id));
    for (const id of Object.keys(this.orphanBackoff)) {
      if (!ids.has(id)) delete this.orphanBackoff[id];
    }
    if (records.length === 0) return;
    const cap = 50;
    const start = this.orphanSweepCursor % records.length;
    let checked = 0;
    let visited = 0;
    for (; visited < records.length && checked < cap; visited += 1) {
      const record = records[(start + visited) % records.length];
      if (await this.sweepOrphan(record)) checked += 1;
    }
    this.orphanSweepCursor = (start + visited) % records.length;
    await this.persistOrphanCursor();
  }

  private async sweepOrphan(record: StoredChiAgent): Promise<boolean> {
    if (record.provider !== "opencode") return false;
    if (!record.archivedAt && this.manager.getAgent(record.id)) return false;
    const previous = this.orphanBackoff[record.id];
    if (previous && previous.nextCheck > Date.now()) return false;
    const association = this.parseAssociation(record.labels?.[label]);
    if (!association?.provenanceRef || !association.actor || !association.sourceId) return false;
    if (association.provenanceRemoved) return false;
    const sessionId = record.persistence?.nativeHandle ?? record.persistence?.sessionId;
    if (!sessionId) return false;
    const delay = Math.min((previous?.delay ?? 150_000) * 2, 24 * 60 * 60 * 1000);
    this.orphanBackoff[record.id] = { nextCheck: Date.now() + delay, delay };
    if (await this.confirmOrphan(record, association)) {
      await this.purgeOrphan(record, association, sessionId);
    }
    return true;
  }

  startProvenanceSweep(): void {
    if (!this.orphanSweepStopped) return;
    this.orphanSweepStopped = false;
    const sweep = async () => {
      try {
        await this.reconcileProvenanceOrphans();
      } catch {
        /* Retry transient authorization, storage and remote failures. */
      } finally {
        if (!this.orphanSweepStopped) {
          this.orphanSweepTimer = setTimeout(() => void sweep(), 60_000);
          this.orphanSweepTimer.unref();
        }
      }
    };
    void sweep();
  }

  stopProvenanceSweep(): void {
    this.orphanSweepStopped = true;
    if (this.orphanSweepTimer) clearTimeout(this.orphanSweepTimer);
    this.orphanSweepTimer = null;
  }

  private orphanCursorPath(): string {
    return join(this.options.home, "chi", "provenance-sweep.json");
  }

  private loadOrphanCursor(): void {
    if (this.orphanCursorLoaded) return;
    this.orphanCursorLoaded = true;
    try {
      const parsed = z
        .object({
          cursor: z.number().int().nonnegative(),
          backoff: z
            .record(
              z.string(),
              z.object({
                nextCheck: z.number().finite().nonnegative(),
                delay: z
                  .number()
                  .finite()
                  .min(300_000)
                  .max(24 * 60 * 60 * 1000),
              }),
            )
            .optional(),
        })
        .parse(JSON.parse(readFileSync(this.orphanCursorPath(), "utf8")));
      this.orphanSweepCursor = parsed.cursor;
      this.orphanBackoff = parsed.backoff ?? {};
      const latestCheck = Date.now() + 24 * 60 * 60 * 1000;
      for (const backoff of Object.values(this.orphanBackoff)) {
        backoff.nextCheck = Math.min(backoff.nextCheck, latestCheck);
      }
    } catch {
      // First run, or an unreadable cursor: start from zero.
    }
  }

  private async persistOrphanCursor(): Promise<void> {
    await mkdir(join(this.options.home, "chi"), { recursive: true, mode: 0o700 });
    await writeJsonFileAtomic(this.orphanCursorPath(), {
      cursor: this.orphanSweepCursor,
      backoff: this.orphanBackoff,
    });
  }

  /** Only an explicit not-found response purges; access loss leaves login intact. */
  private async confirmOrphan(record: StoredChiAgent, association: Association): Promise<boolean> {
    try {
      const authority = this.authorityFor(this.requireAssociation(association).endpoint!);
      const auth = await this.authorizeRepository(association.repo, record.cwd, authority);
      if (!sameActor(auth.chiUserId, association.actor)) return false;
      return !(await nativeSourceExists(
        {
          endpoint: authority.endpoint,
          token: auth.sessionToken,
          repo: association.repo,
          sourceId: association.sourceId!,
        },
        authority.request,
      ));
    } catch {
      return false;
    }
  }

  private async purgeOrphan(
    record: StoredChiAgent,
    association: Association,
    sessionId: string,
  ): Promise<void> {
    try {
      const outcome = await this.provenanceRemover({
        root: record.cwd,
        user: association.actor,
        sessionId,
        ref: association.provenanceRef!,
      });
      if (outcome.removed) {
        await this.patchAssociation(record.id, {
          provenanceRemoved: true,
          provenanceRef: undefined,
          provenanceError: null,
        }).catch(() => undefined);
      } else {
        await this.patchAssociation(record.id, { provenanceError: outcome.reason }).catch(
          () => undefined,
        );
      }
    } catch {
      // A stored record that is not loaded cannot be patched; the purge stands.
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
  ): (ResolvedChiDestination & { actor: string | null }) | null {
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
        matchedRule: resolveChiDestinationForRepo(config, association.repo)?.matchedRule ?? null,
        actor: association.actor || null,
      };
    }
    return null;
  }

  private aggregateSync(identities: Array<{ association: Association | null }>): {
    pending: boolean;
    error: string | null;
    warning: string | null;
  } {
    let pending = false;
    let error: string | null = null;
    let warning: string | null = null;
    for (const { association } of identities) {
      if (!association) continue;
      if (association.capturePending) pending = true;
      if (association.error) error = association.error;
      if (association.warning) warning = association.warning;
    }
    return { pending, error, warning };
  }

  async syncStatus(input: { workspaceId: string; cwd: string; retry?: boolean }): Promise<{
    destination: ChiSyncDestination | null;
    pending: boolean;
    error: string | null;
    warning: string | null;
    mentionsAvailable: boolean;
  }> {
    const identities = await this.workspaceIdentities(input.workspaceId);
    for (const identity of identities) {
      if (identity.association)
        identity.association = this.resolveAssociation(identity.association);
    }
    if (input.retry)
      for (const identity of identities) void this.capture(identity.id).catch(() => undefined);
    const fromAssociations = this.destinationFromIdentities(identities, this.chiConfig());
    const resolved = fromAssociations ?? (await this.resolveForCwd(input.cwd, { cache: true }));
    const { pending, error, warning } = this.aggregateSync(identities);
    const actor = fromAssociations?.actor ?? null;
    return {
      destination: resolved
        ? {
            id: resolved.destinationId,
            name: resolved.name,
            endpoint: resolved.endpoint,
            audience: resolved.audience,
            actor,
            matchedRule: resolved.matchedRule,
          }
        : null,
      pending,
      error,
      warning,
      mentionsAvailable: Boolean(resolved && !error && resolved.endpoint === this.primaryEndpoint),
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

  private async scanPublicationCapture(
    capture: unknown,
    sessionId: string,
    destination: ConversationDestination,
  ): Promise<void> {
    let receiptCapture: CaptureInput["capture"];
    try {
      receiptCapture = prepareNativeCapture({
        capture: capture as CaptureInput["capture"],
        sessionId,
      }).capture;
    } catch {
      throw new Error("chi-conversation-capture-unminimised");
    }
    if (
      receiptCapture.harness !== "opencode-v2" ||
      receiptCapture.coverage.kind !== "export" ||
      receiptCapture.mapping.instanceId !== destination.instanceId ||
      receiptCapture.mapping.workspace.hostId !== destination.workspace.hostId ||
      receiptCapture.mapping.workspace.path !== destination.workspace.path
    )
      throw new Error("chi-conversation-capture-unminimised");
    const receiptScan = {
      native: receiptCapture.native,
      mapping: receiptCapture.mapping,
      coverage: receiptCapture.coverage,
      sessionId,
      projection: receiptCapture.projection,
      ...(receiptCapture.git ? { git: receiptCapture.git } : {}),
    };
    await this.scanCapture(receiptScan, receiptScan);
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
      const native = JSON.stringify(await runtime.export(sessionId));
      const coverage = { kind: "export" as const, reason: null };
      const minimised = minimiseNativeExport({
        native,
        mapping: destination,
        coverage,
        sessionId,
      }).capture;
      const verdict = await this.scanCapture(
        { native, mapping: destination, coverage, sessionId },
        {
          native: minimised.native,
          mapping: destination,
          coverage,
          sessionId,
          projection: minimised.projection,
          ...(minimised.git ? { git: minimised.git } : {}),
        },
      );
      if (verdict.verdict !== "clean") {
        const warning =
          verdict.verdict === "attribution-unavailable"
            ? "capture-local-attribution-unavailable"
            : "capture-local-secret-omitted-content";
        await this.patchAssociation(snapshot.id, { warning });
      }
      const publication: PublishRequest = {
        id,
        revision: current.conversation.revision,
        transferId,
        claimId,
        capture: minimised,
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
    // A saved receipt may predate this build. Never transmit it unchanged:
    // require the supported v2 min-v1 projection and scan its exact capture
    // (the same bytes that would publish).
    await this.scanPublicationCapture(publication.capture, sessionId, destination);
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
    const resolved = resolveChiDestinationForRepo(this.chiConfig(), input.repo);
    if (!resolved) throw new Error("chi-destination-required");
    if (resolved.endpoint !== this.authority.endpoint) throw new Error("chi-destination-required");
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
            destination: resolved.destinationId,
            endpoint: resolved.endpoint,
            audience: resolved.audience,
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
