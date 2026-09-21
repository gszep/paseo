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
import { append, boundedText, endpointUrl } from "@henkaku-center/chi-native/http";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { readQuarantinedSessions } from "./quarantine.js";
import { execCommand } from "../../utils/spawn.js";

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
  private client(repo: string, token: string) {
    return new ConversationClient(
      { repo, token, endpoint: this.authority.endpoint },
      this.authority.request,
    );
  }
  async assertCurrent(agent: { cwd: string; labels: Record<string, string> }): Promise<void> {
    const encoded = agent.labels[label];
    if (!encoded) return;
    const association = associationSchema.parse(JSON.parse(encoded));
    if (association.blocked) throw new Error("chi-conversation-pending");
    if (!association.conversationId) return;
    const auth = await this.authorize(association.repo, agent.cwd);
    if (auth.chiUserId !== association.actor) throw new Error("chi-identity-mismatch");
    const { conversation } = await this.client(association.repo, auth.sessionToken).get({
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
      const auth = await this.authorize(association.repo, agent.cwd);
      if (auth.chiUserId !== association.actor) throw new Error("chi-identity-mismatch");
      const client = this.client(association.repo, auth.sessionToken);
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
    const auth = await this.authorize(repo, agent.cwd);
    const encoded = await this.manager.updateAgentLabel(agentId, label, (current) => {
      if (current) {
        const previous = associationSchema.parse(JSON.parse(current));
        if (previous.repo !== repo) throw new Error("chi-association-conflict");
        if (previous.actor !== auth.chiUserId) throw new Error("chi-identity-mismatch");
        return current;
      }
      return JSON.stringify({
        repo,
        actor: auth.chiUserId,
        sourceId: null,
        head: null,
        error: null,
      });
    });
    const previous = associationSchema.parse(JSON.parse(encoded));
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
      if (association.conversationId && !association.sourceId)
        throw new Error("chi-conversation-publication-pending");
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
      return await this.patchAssociation(agentId, {
        sourceId: result.sourceId,
        head: result.head,
        error: null,
      });
    } catch (error) {
      const code = safeChiError(error);
      await this.patchAssociation(agentId, { error: code });
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

  private async claimJournal(
    input: ContinueSelection,
    actor: string,
    client: ConversationClient,
    destination: ConversationDestination,
    path: string,
  ): Promise<ClaimJournal | null> {
    const canonical = input.canonical;
    if (!canonical) return null;
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
    const key = input.canonical
      ? createHash("sha256")
          .update(
            JSON.stringify([
              input.repo,
              input.canonical.conversationId,
              input.canonical.transferId,
            ]),
          )
          .digest("hex")
      : input.requestId;
    if (this.continuing.has(key)) throw new Error("chi-continuation-in-progress");
    this.continuing.add(key);
    try {
      const auth = await this.authorize(input.repo, input.cwd);
      const receipts = join(this.options.home, "chi", "receipts");
      await mkdir(receipts, { recursive: true, mode: 0o700 });
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))
        throw new Error("chi-invalid-request-id");
      const client = this.client(input.repo, auth.sessionToken);
      const canonical = input.canonical;
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
        if (journal && !previous) {
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
            ...(canonical ? { conversationId: canonical.conversationId, blocked: true } : {}),
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
          if (!canonical) return { sessionId: receipt.destination.sessionId, snapshot: existing };
        }
        if (previous && !existing) await verifyContinuationReceipt(receipt, runtime);
        const permit = {};
        if (canonical)
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
            (await registration.register(
              receipt.destination.sessionId,
              labels,
              canonical ? permit : undefined,
            ));
        } finally {
          this.registrationPermits.delete(permit);
        }
        const canonicalCurrent = journal
          ? await this.publishFork(
              journal,
              journalPath,
              client,
              runtime,
              receipt.destination.sessionId,
              snapshot,
            )
          : undefined;
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
  if (error instanceof ContinuationError) return error.message;
  if (error instanceof Error && /^(?:chi|evidence|capture)-[a-z0-9-]+$/.test(error.message))
    return error.message;
  return "chi-operation-failed";
}
