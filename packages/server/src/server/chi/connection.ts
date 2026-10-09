import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  nativeSourceExists,
  scanCaptureVerdict,
  type LocalScanInput,
  type LocalScanVerdict,
} from "@henkaku-center/chi-native/capture";
import type {
  Conversation,
  ConversationReply,
  ConversationDestination,
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
import { HumanPrompts, quoteHumanAnswer, type HumanPromptOperation } from "./human-prompts.js";
import type {
  ChiMentionOperation,
  ChiMentionContext,
  ChiHandoff,
} from "@getpaseo/protocol/chi-mentions";
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
import { removeProvenance, type ProvenanceRemover, type ProvenanceWriter } from "./provenance.js";
import { captureAppend, supportsAppendCapture, type AppendCaptureInput } from "./append-capture.js";
import { parsePin, type Pin } from "@henkaku-center/chi-native/append-codec";
import { AppendHttpError } from "@henkaku-center/chi-native/append-client";

const label = "chi.native";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const associationSchema = z.object({
  repo: z.string(),
  actor: z.string(),
  sourceId: hash.nullable(),
  head: hash.nullable(),
  pin: z
    .custom<Pin>((value) => {
      try {
        parsePin(value);
        return true;
      } catch {
        return false;
      }
    })
    .optional(),
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
interface ContinueResult {
  sessionId: string;
  snapshot: ManagedAgent;
  canonicalCurrent: Conversation["current"] & { conversationId: string };
}
function sameActor(a: string, b: string): boolean {
  // A GitHub login is case-insensitive to the backend; the label may hold the
  // login as typed by either the mention path (lowercased) or the capture path.
  return a.toLowerCase() === b.toLowerCase();
}
function sameCaptureScope(current: Association, expected: Association): boolean {
  return (
    current.repo === expected.repo &&
    current.endpoint === expected.endpoint &&
    sameActor(current.actor, expected.actor) &&
    current.destination === expected.destination &&
    current.audience === expected.audience
  );
}
/** Secret rejections, cut-scan limits and divergence require human recovery.
 * A missing local scanner is retryable (install it and the next turn/reconnect retries). */
const TERMINAL_SYNC_ERRORS = new Set<string>([
  "capture-head-diverged",
  "capture-recovery-invalid",
  "capture-local-secret-rejected",
  "capture-local-cut-scan-limit",
  "capture-local-secret-scan-limit",
  "evidence-http-422-server-secret-scan-rejected",
  "append-recovery-required",
  "append-local-conflict",
  "append-local-state-invalid",
  "capture-native-projection-invalid",
  "chi-native-reset-required",
  "chi-native-runtime-unsupported",
  "chi-native-fork-unsupported",
  "chi-native-workspace-mismatch",
  "chi-native-platform-unsupported",
  "append-http-404",
]);
function isTerminalSyncError(error: string | null | undefined): boolean {
  return typeof error === "string" && TERMINAL_SYNC_ERRORS.has(error);
}
const authSchema = z.object({
  ok: z.literal(true),
  chiUserId: z.string(),
  capabilities: z.unknown().optional(),
});
const appendCapabilitiesSchema = z.object({
  appendLog: z.object({ v: z.literal(3), deployment: z.string().min(1) }),
  handoffs: z.object({ v: z.literal(3), references: z.literal("pin-seq") }),
});
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
  /** Local full→minimised scan gate; defaults to the vendored verdict scanner. */
  scanCapture?: (full: LocalScanInput, minimised: LocalScanInput) => Promise<LocalScanVerdict>;
  appendScanner?: AppendCaptureInput["scanner"];
  /** Hidden provenance writer; defaults to the vendored chi-native writer. */
  provenance?: ProvenanceWriter;
  provenanceRemover?: ProvenanceRemover;
  /** Scanner binary forwarded to the default provenance writer (tests). */
  provenanceScanner?: string;
  /** Persisted agents not yet loaded into memory, for restart reconciliation. */
  listStoredAgents?: () => Promise<readonly StoredChiAgent[]>;
  getStoredAgent?: (agentId: string) => Promise<StoredChiAgent | null>;
  getWorkspaceName?: (workspaceId: string) => Promise<string | undefined>;
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

export class ChiConnection {
  readonly mentions: ChiMentions;
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
  async assertCurrent(agent: { cwd: string; labels: Record<string, string> }): Promise<void> {
    const encoded = agent.labels[label];
    if (!encoded) return;
    const stored = associationSchema.parse(JSON.parse(encoded));
    if (stored.conversationId || stored.blocked) throw new Error("chi-native-reset-required");
  }
  withPromptAdmission<T>(agentId: string, start: () => Promise<T>): Promise<T> {
    return this.exclusive(agentId, async () => {
      const agent = this.manager.getAgent(agentId);
      if (!agent) throw new Error("chi-native-agent-required");
      await this.assertCurrent(agent);
      return start();
    });
  }
  async prepare(
    _agentId: string,
    _transferId: string,
    _destination: ConversationDestination,
  ): Promise<ConversationReply> {
    throw new Error("chi-operation-unsupported");
  }
  async reconcile(_agentId: string, _cancel = false): Promise<ConversationReply> {
    throw new Error("chi-operation-unsupported");
  }
  private readonly pending = new Map<string, Promise<Association>>();
  private readonly dirty = new Set<string>();
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
    this.provenanceRemover = options.provenanceRemover ?? removeProvenance;
    const getAuthority = () => this.authority;
    this.mentions = new ChiMentions(options.home, {
      get endpoint() {
        return getAuthority().endpoint;
      },
      request: async (url, init) => {
        const response = await this.authority.request(url, init);
        if ([401, 403, 404].includes(response.status)) {
          this.loseMentionAuthority();
        }
        return response;
      },
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

  private loseMentionAuthority() {
    this.participants.clear();
    for (const authority of this.authorityByEndpoint.values()) authority.invalidate();
  }

  private async mentionIdentity(cwd: string, directoryOnly = false): Promise<MentionIdentity> {
    try {
      const remote = await execCommand("git", ["remote", "get-url", "origin"], {
        cwd,
        timeout: 5000,
      });
      const parsed = parseGitHubRemote(remote.stdout);
      if (!parsed) throw new Error("chi-repository-mismatch");
      const repo = `github:${parsed.owner}/${parsed.repo}`.toLowerCase();
      const resolved = resolveChiDestinationForRepo(this.chiConfig(), repo);
      if (!resolved) throw new Error("chi-destination-required");
      if (resolved.endpoint !== this.authority.endpoint)
        throw new Error("chi-mentions-unavailable");
      const auth = directoryOnly
        ? await this.verifiedSession(this.authority)
        : await this.authorize(repo, cwd);
      return {
        repo,
        deployment: auth.appendDeployment,
        actor: auth.chiUserId.toLowerCase(),
        token: auth.sessionToken,
        credentialGeneration: auth.credentialGeneration,
        humanPrompts: false,
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
    const workspaceName = agent.workspaceId
      ? await this.options.getWorkspaceName?.(agent.workspaceId)
      : undefined;
    await this.mentions.prepare({
      agentId,
      messageId,
      text,
      recipients,
      identity,
      admission,
      workspaceName,
    });
  }

  private mentionContext(identity: MentionIdentity): ChiMentionContext {
    return {
      actor: identity.actor,
      repo: identity.repo,
      deployment: this.authority.endpoint,
      evidenceVersion: 3,
      generation: createHash("sha256")
        .update(
          JSON.stringify([
            this.authority.endpoint,
            identity.actor,
            identity.repo,
            identity.deployment,
            identity.credentialGeneration ?? identity.token,
          ]),
        )
        .digest("hex"),
    };
  }

  private async humanPromptAuthority(agentId: string) {
    const agent = this.manager.getAgent(agentId);
    if (!agent || agent.provider !== "opencode") throw new Error("chi-native-agent-required");
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
    const identity = await this.mentionIdentity(agent.cwd);
    if (
      association.repo.toLowerCase() !== identity.repo ||
      association.actor?.toLowerCase() !== identity.actor
    )
      throw new Error("chi-human-prompt-mapping-required");
    await this.assertCurrent(agent);
    const sessionId = agent.persistence?.nativeHandle ?? agent.persistence?.sessionId;
    if (!sessionId) throw new Error("chi-native-agent-required");
    const turnId = "session" in agent ? await agent.session?.humanPromptTurnId?.() : null;
    if (!turnId) throw new Error("chi-human-prompt-native-turn-required");
    const scope = {
      agentId,
      sessionId,
      turnId,
      context: this.mentionContext(identity),
      pendingQuestionIds: [...agent.pendingPermissions.values()]
        .filter(
          (r) =>
            r.kind === "question" &&
            r.metadata?.source === "opencode_question" &&
            this.isRoutableHumanQuestion(r) &&
            r.metadata.sessionId === sessionId,
        )
        .map((r) => r.id),
    };
    return { scope, identity, association };
  }

  private async humanPromptAccess(agentId: string, signal?: AbortSignal) {
    const initial = await this.humanPromptAuthority(agentId);
    signal?.throwIfAborted();
    const check = async () => {
      signal?.throwIfAborted();
      const current = await this.humanPromptAuthority(agentId);
      signal?.throwIfAborted();
      if (current.scope.sessionId !== initial.scope.sessionId)
        throw new Error("chi-human-prompt-context-changed");
      this.requireMentionContext(current.identity, initial.scope.context);
      return current.identity;
    };
    const transport = {
      signal,
      dispatchEnabled: initial.identity.humanPrompts === true,
      viewed: (recipient: string) =>
        this.isHumanPromptViewed(agentId, recipient, initial.identity.actor),
      create: async (batch: Parameters<ChiMentions["createHandoff"]>[1]) => {
        signal?.throwIfAborted();
        // Reads share the boundary bracket; a write needs fresh admission after
        // any awaited reads, as well as verification after the response.
        const current = await check();
        if (!current.humanPrompts) throw new Error("chi-human-prompts-backend-upgrade-required");
        const result = await this.mentions.createHandoff(current, batch);
        await check();
        return result;
      },
      read: async (id: string) => {
        const result = await this.mentions.execute(initial.identity, { action: "read", id });
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

  async humanPromptBoundary(agentId: string, remind = true): Promise<string | null> {
    const signal = AbortSignal.timeout(2000);
    return Promise.race([
      this.humanPromptBoundaryStep(agentId, remind, signal),
      new Promise<null>((resolve) =>
        signal.addEventListener("abort", () => resolve(null), { once: true }),
      ),
    ]);
  }
  private async humanPromptBoundaryStep(
    agentId: string,
    remind: boolean,
    signal: AbortSignal,
  ): Promise<string | null> {
    try {
      if (!(await this.humanPrompts.hasItems(agentId))) return null;
      const access = await this.humanPromptAccess(agentId, signal);
      const { association } = access;
      const source =
        association.sourceId && association.head && association.promptEntryId
          ? {
              kind: "neutral" as const,
              id: association.sourceId,
              snapshot: association.head,
              entryId: association.promptEntryId,
            }
          : null;
      const reminder = await this.humanPrompts.boundary(access.scope, access.transport, {
        source,
        viewed: false,
        remind,
      });
      await access.check();
      return reminder;
    } catch {
      // A segment failure withholds data and never blocks an unrelated model turn.
      return null;
    }
  }

  private readonly questionLanes = new Set<string>();
  private isRoutableHumanQuestion(request: { kind?: string; metadata?: Record<string, unknown> }) {
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
            request.id,
            false,
          );
        }
      }
      const { association } = access;
      await this.humanPrompts.boundary(access.scope, access.transport, {
        source:
          association.sourceId && association.head && association.promptEntryId
            ? {
                kind: "neutral",
                id: association.sourceId,
                snapshot: association.head,
                entryId: association.promptEntryId,
              }
            : null,
        viewed: false,
        remind: false,
      });
      const result = await this.humanPrompts.operate(
        access.scope,
        { action: "resolve" },
        access.transport,
        null,
        false,
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
  }

  private requireMentionContext(identity: MentionIdentity, expected?: ChiMentionContext) {
    const current = this.mentionContext(identity);
    if (
      !expected ||
      expected.evidenceVersion !== 3 ||
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
        const auth = await this.verifiedSession(this.authority);
        return {
          actor: auth.chiUserId.toLowerCase(),
          token: auth.sessionToken,
          credentialGeneration: auth.credentialGeneration,
          repo: "*",
          deployment: auth.appendDeployment,
        };
      } catch (error) {
        throw new ChiOperationError(safeChiError(error), { accessLost: true, outcome: "unknown" });
      }
    };
    try {
      const current = await identity();
      const context = this.mentionContext(current);
      const config = this.chiConfig();
      const mapped = (config?.mappings ?? []).filter(
        (mapping) =>
          config?.destinations[mapping.destination]?.endpoint === this.authority.endpoint,
      );
      if (mapped.length === 1) context.defaultRepository = mapped[0]!.repo;
      if (operation.action === "scope") {
        // Account discovery needs identity only. The picker acquires its catalog
        // separately; each repository read still authorizes at the backend.
        if (operation.includeRepositories !== false) {
          const response = await this.authority.request(
            append(endpointUrl(this.authority.endpoint), "repos"),
            {
              redirect: "error",
              signal: AbortSignal.timeout(30000),
              headers: { authorization: `Bearer ${current.token}` },
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`chi-http-${response.status}`);
          }
          const catalog = reposSchema.parse(JSON.parse(await boundedText(response, 1024 * 1024)));
          context.repositories = catalog.repos.map((item) => item.repo);
        }
        this.requireMentionContext(await identity(), context);
        return { context, result: { kind: "scope" as const, actor: current.actor } };
      }
      this.requireMentionContext(current, expected);
      if (
        operation.action === "participants" ||
        operation.action === "delivery" ||
        operation.action === "retry" ||
        operation.action === "list"
      )
        throw new Error("chi-mention-workspace-required");
      const repo = operation.repo;
      if (!repo) throw new Error("chi-mention-repository-required");
      // Backend authorizes the supplied repository; inbox transport needs no local checkout.
      // Catalog loading is independent discovery, never an authorization verdict.
      const result = await this.mentions.execute({ ...current, repo }, operation);
      if (result.kind === "inbox") await this.nameInboxWorkspaces(repo, result.handoffs);
      this.requireMentionContext(await identity(), context);
      return { context: { ...context, repositories: expected?.repositories }, result };
    } catch (error) {
      if (classifyMentionFailure(error).accessLost) this.loseMentionAuthority();
      throw error;
    }
  }

  private async nameInboxWorkspaces(repo: string, handoffs: ChiHandoff[]) {
    const getName = this.options.getWorkspaceName;
    if (!getName) return;
    const workspaces = new Map<string, string>();
    for (const agent of this.manager.listAgents()) {
      if (!agent.workspaceId || !agent.labels[label]) continue;
      let association: Association;
      try {
        association = associationSchema.parse(JSON.parse(agent.labels[label]!));
      } catch {
        continue;
      }
      if (
        association.repo === repo &&
        association.sourceId &&
        association.endpoint === this.authority.endpoint
      )
        workspaces.set(association.sourceId, agent.workspaceId);
    }
    const names = new Map<string, Promise<string | undefined>>();
    for (const handoff of handoffs) {
      if (handoff.workspaceName) continue;
      const source = handoff.sources[0];
      const workspace = source?.kind === "neutral" ? workspaces.get(source.id) : undefined;
      if (!workspace) continue;
      let name = names.get(workspace);
      if (!name) {
        name = getName(workspace);
        names.set(workspace, name);
      }
      const workspaceName = await name;
      if (workspaceName) handoff.workspaceName = workspaceName;
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
      if (classifyMentionFailure(error).accessLost) this.loseMentionAuthority();
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
    const session = await this.verifiedSession(authority);
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
    const catalog = reposSchema.parse(await get("repos"));
    if (!catalog.repos.some((entry) => entry.repo.toLowerCase() === repo.toLowerCase()))
      throw new Error("chi-repository-denied");
    return session;
  }

  private async verifiedSession(authority: ChiAuthority) {
    if (!supportsAppendCapture()) throw new Error("chi-native-platform-unsupported");
    const session = await authority.login();
    const response = await authority.request(
      append(endpointUrl(authority.endpoint), "auth/session"),
      {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: { authorization: `Bearer ${session.sessionToken}` },
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`chi-http-${response.status}`);
    }
    const identity = authSchema.parse(JSON.parse(await boundedText(response, 65536)));
    if (!sameActor(identity.chiUserId, session.chiUserId)) throw new Error("chi-identity-mismatch");
    const capabilities = appendCapabilitiesSchema.safeParse(identity.capabilities);
    if (!capabilities.success) throw new Error("chi-native-v3-required");
    return {
      ...session,
      appendDeployment: capabilities.data.appendLog.deployment,
      humanPrompts: false,
    };
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
    await this.manager.updateAgentLabel(agentId, label, (current) => {
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
    return this.capture(agentId);
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

  capture(agentId: string): Promise<Association> {
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
          const result = await this.captureOnce(fresh);
          if (!this.dirty.has(agentId)) return result;
        } catch (error) {
          if (safeChiError(error) !== "chi-session-busy" || !this.dirty.has(agentId)) throw error;
        }
      }
    })();
    this.pending.set(agentId, operation);
    void operation
      .then(
        () => this.captureBackoff.delete(agentId),
        (error) => {
          if (safeChiError(error) === "chi-session-busy") return;
          const delay = Math.min((this.captureBackoff.get(agentId)?.delay ?? 30_000) * 2, 900_000);
          this.captureBackoff.set(agentId, { delay, nextCheck: Date.now() + delay });
        },
      )
      .catch(() => undefined);
    void operation
      .finally(() => {
        this.pending.delete(agentId);
        this.dirty.delete(agentId);
      })
      .catch(() => undefined);
    return operation;
  }

  private async captureOnce(target: CaptureTarget): Promise<Association> {
    const agentId = target.id;
    let association = target.labels[label]
      ? associationSchema.parse(JSON.parse(target.labels[label]!))
      : null;
    if (!association) throw new Error("chi-share-required");
    association = await this.reconcileAssociation(agentId, association);
    if (association.paused) throw new Error(association.error ?? "chi-destination-paused");
    try {
      if (association.sourceId !== null && !association.pin)
        throw new Error("chi-native-reset-required");
      if (association.conversationId) throw new Error("chi-native-reset-required");
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
      const confirmScope = async () => {
        const current = await this.verifiedSession(authority);
        if (
          !sameActor(current.chiUserId, auth.chiUserId) ||
          current.credentialGeneration !== auth.credentialGeneration ||
          current.appendDeployment !== auth.appendDeployment
        )
          throw new Error("chi-mention-context-changed");
      };
      const patchConfirmed = async (patch: Partial<Association>) => {
        await confirmScope();
        this.endpointFor(endpoint);
        return this.patchAssociation(agentId, (current) => {
          if (!sameCaptureScope(current, pinned)) throw new Error("chi-mention-context-changed");
          return patch;
        });
      };
      await this.patchAssociation(agentId, { capturePending: true });
      const sessionId = target.persistence.nativeHandle ?? target.persistence.sessionId;
      if (!sessionId) throw new Error("chi-native-agent-required");
      const captured = await this.manager.withNativeRuntime(sessionId, async (runtime) => {
        const runtimeInfo = z
          .object({ version: z.literal("2.0.15-chi.1") })
          .safeParse(await runtime.info());
        if (!runtimeInfo.success) throw new Error("chi-native-runtime-unsupported");
        const native = await runtime.export(sessionId);
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
        return captureAppend({
          home: this.options.home,
          endpoint,
          deployment: auth.appendDeployment,
          token: auth.sessionToken,
          repo: pinned.repo,
          actor: auth.chiUserId,
          sessionId,
          instanceId: `${this.options.serverId}:opencode`,
          hostId: this.options.serverId,
          cwd: target.cwd,
          native,
          expected: pinned.pin ?? null,
          visibility: pinned.audience ?? "private",
          request: authority.request,
          scanner: this.options.appendScanner,
          scanCapture: this.scanCapture,
          onConfirmed: async (pin) => {
            await patchConfirmed({
              sourceId: pin.sourceId,
              head: pin.head,
              pin,
              capturePending: true,
            });
          },
        });
      });
      const updated = await patchConfirmed({
        sourceId: captured.pin.sourceId,
        head: captured.pin.head,
        pin: captured.pin,
        error: null,
        capturePending: false,
        warning: captured.warning,
        promptEntryId: captured.messages.at(-1)?.id,
      });
      if (endpoint === this.primaryEndpoint) {
        await confirmScope();
        await this.mentions.captured({
          agentId,
          identity: {
            repo: pinned.repo,
            actor: auth.chiUserId.toLowerCase(),
            token: auth.sessionToken,
            deployment: auth.appendDeployment,
          },
          pin: captured.pin,
          messages: captured.messages,
        });
      }
      return updated;
    } catch (error) {
      return this.captureFailed(target, association, error);
    }
  }

  private async captureFailed(
    target: CaptureTarget,
    association: Association,
    error: unknown,
  ): Promise<never> {
    const code = safeChiError(error);
    const updated = await this.patchAssociation(target.id, (current) => {
      if (!sameCaptureScope(current, association)) return {};
      const resolved = this.resolveAssociation(current);
      if (resolved.paused) return resolved;
      if (code === "chi-session-busy") return {};
      return { error: code, capturePending: !isTerminalSyncError(code) };
    });
    if (updated.paused) throw new Error(updated.error ?? "chi-destination-required");
    throw new Error(code, { cause: error });
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
    association = { ...association, repo: association.repo.toLowerCase() };
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

  afterTurn(agentId: string): void {
    const agent = this.manager.getAgent(agentId);
    if (!agent || agent.provider !== "opencode") return;
    const association = this.association(agent);
    // A settled turn bypasses sweep backoff, but never a human-recovery stop.
    if (association && isTerminalSyncError(association.error)) return;
    // A genuinely local workspace (no mapping at all) stays quiet.
    if (!association && !this.chiConfig()) return;
    // Capture runs after manager turn reconciliation; the pending map coalesces
    // duplicate lifecycle notifications without polling or a second process.
    queueMicrotask(() => {
      void this.capture(agentId)
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
    for (const candidate of await this.candidateLabels()) {
      if (!candidate.labels[label]) continue;
      if (isTerminalSyncError(this.parseAssociation(candidate.labels[label])?.error)) continue;
      void this.capture(candidate.id).catch(() => undefined);
    }
  }

  private readonly captureBackoff = new Map<string, { nextCheck: number; delay: number }>();
  private captureSweepCursor = 0;
  private captureSweep: Promise<void> | null = null;

  /** Retry durable pending captures, bounded across timer and reconnect callers. */
  reconcilePending(): Promise<void> {
    if (this.captureSweep) return this.captureSweep;
    this.captureSweep = this.sweepPending().finally(() => {
      this.captureSweep = null;
    });
    return this.captureSweep;
  }

  private async sweepPending(): Promise<void> {
    const candidates = (await this.candidateLabels()).sort((a, b) => a.id.localeCompare(b.id));
    const ids = new Set(candidates.map((candidate) => candidate.id));
    for (const id of this.captureBackoff.keys()) if (!ids.has(id)) this.captureBackoff.delete(id);
    let attempted = 0;
    let visited = 0;
    for (; visited < candidates.length && attempted < 4; visited++) {
      const candidate = candidates[(this.captureSweepCursor + visited) % candidates.length]!;
      const association = this.parseAssociation(candidate.labels[label]);
      if (
        !association ||
        association.paused ||
        !association.capturePending ||
        isTerminalSyncError(association.error) ||
        this.pending.has(candidate.id) ||
        (this.captureBackoff.get(candidate.id)?.nextCheck ?? 0) > Date.now()
      )
        continue;
      attempted++;
      await this.capture(candidate.id).catch(() => undefined);
    }
    this.captureSweepCursor = candidates.length
      ? (this.captureSweepCursor + visited) % candidates.length
      : 0;
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
        await Promise.all([this.reconcilePending(), this.reconcileProvenanceOrphans()]);
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
      // Capture failures belong to individual sessions, not the people directory.
      // Directory reads still acquire their own authenticated repository scope.
      mentionsAvailable: Boolean(resolved && resolved.endpoint === this.primaryEndpoint),
    };
  }
  async continue(
    _input: ContinueSelection,
    _registration: {
      find(sessionId: string): Promise<ManagedAgent | null>;
      register(
        sessionId: string,
        labels: Record<string, string>,
        chiRegistration?: object,
      ): Promise<ManagedAgent>;
    },
  ): Promise<ContinueResult> {
    throw new Error("chi-operation-unsupported");
  }
}

export function safeChiError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") return "chi-operation-timeout";
  if (error instanceof EvidenceHttpError && error.reason) return `${error.message}-${error.reason}`;
  if (error instanceof AppendHttpError && error.status === 422)
    return "capture-native-projection-invalid";
  if (error instanceof Error && error.message === "native-projection-invalid")
    return "capture-native-projection-invalid";
  if (error instanceof AppendHttpError && error.status === 409) return "append-recovery-required";
  if (error instanceof Error && /^(?:chi|evidence|capture|append)-[a-z0-9-]+$/.test(error.message))
    return error.message;
  return "chi-operation-failed";
}
