import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MessageReceipts } from "../message-receipts/index.js";
import type { SendAgentMessageRequest } from "@getpaseo/protocol/messages";
import { append, boundedText, endpointUrl } from "@henkaku-center/chi-native/http";
import {
  canonicalJson,
  decodeEntry,
  parseNativeJson,
  parseJson,
  parsePin,
  type Pin,
} from "@henkaku-center/chi-native/append-codec";
import {
  readConversationReceipt,
  publishConversationReceipt,
  writeConversationReceipt,
} from "@henkaku-center/chi-native/conversations";
import {
  ChiParticipantSchema,
  ChiHandoffSchema,
  ChiSourceSchema,
  ChiDeliverySchema,
  ChiEntryRefSchema,
  type ChiMentionOperation,
  type ChiMentionResult,
  type ChiParticipant,
  type ChiHandoff,
  type ChiSource,
} from "@getpaseo/protocol/chi-mentions";

export interface MentionIdentity {
  repo: string;
  actor: string;
  token: string;
  deployment: string;
  credentialGeneration?: string;
  humanPrompts?: boolean;
}
export interface MentionAuthority {
  endpoint: string;
  request: typeof fetch;
}
const receiptSchema = z.object({
  version: z.literal(3),
  agentId: z.string(),
  messageId: z.string(),
  repo: z.string(),
  actor: z.string(),
  endpoint: z.string(),
  deployment: z.string(),
  text: z.string(),
  admission: z.string().optional(),
  source: ChiSourceSchema.nullable(),
  deliveries: z.array(ChiDeliverySchema),
});
type Receipt = z.infer<typeof receiptSchema>;
interface CapturedMessage {
  id: string;
  seq: number;
  payload: Record<string, unknown>;
}
const userMessage = z
  .object({
    type: z.literal("user"),
    metadata: z.object({ paseoClientMessageId: z.string() }),
    text: z.string(),
  })
  .passthrough();
const participantsSchema = z.object({
  ok: z.literal(true),
  self: z.string(),
  participants: z.array(ChiParticipantSchema),
});
const handoffWireSchema = ChiHandoffSchema.pick({
  id: true,
  repo: true,
  author: true,
  recipient: true,
  text: true,
  state: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
  readAt: true,
}).extend({ v: z.literal(3), sources: z.array(ChiEntryRefSchema).min(1).max(32) });
const handoffSchema = z.object({ ok: z.literal(true), handoff: handoffWireSchema });

function sourceView(ref: z.infer<typeof ChiEntryRefSchema>): ChiSource {
  // Existing protocol readers retain display keys. Only appendRef is evidence
  // authority; a v3 pin is never reconstructed from legacy snapshot fields.
  return {
    kind: "neutral",
    id: ref.pin.sourceId,
    snapshot: ref.pin.head,
    entryId: String(ref.seq),
    appendRef: ref,
  };
}
function handoffView(input: unknown, identity: MentionIdentity): ChiHandoff {
  const handoff = handoffWireSchema.parse(input);
  if (handoff.repo !== identity.repo) throw new Error("chi-mention-invalid-response");
  for (const ref of handoff.sources) {
    if (
      ref.pin.repo !== identity.repo ||
      ref.pin.deployment !== identity.deployment ||
      ref.seq >= ref.pin.count
    )
      throw new Error("chi-mention-invalid-response");
  }
  return {
    ...handoff,
    schemaVersion: 1,
    evidenceVersion: 3,
    events: [],
    sources: handoff.sources.map(sourceView),
  };
}

export function mentionFailure(error: unknown): string {
  if (error instanceof Error && /^chi-[a-z0-9-]+$/.test(error.message)) return error.message;
  return "chi-mentions-unavailable";
}

export function assertMentionSend(msg: SendAgentMessageRequest) {
  if (!msg.chiMentions) return;
  if (Buffer.byteLength(msg.text) > 8000) throw new Error("chi-mention-text-too-long");
  if (
    msg.chiMentionAuthorization &&
    (msg.chiMentionAuthorization.actor !== msg.chiMentionContext?.actor ||
      msg.chiMentionAuthorization.repo !== msg.chiMentionContext?.repo)
  )
    throw new Error("chi-mention-context-changed");
  if (
    !msg.messageId ||
    msg.text.trimStart().startsWith("/") ||
    msg.images?.length ||
    msg.attachments?.length
  )
    throw new Error("chi-mention-plain-text-required");
}

/** Private delivery receipts hold intent and immutable pins; Chi owns all messages and ACLs. */
export class ChiMentions {
  private readonly lanes = new Map<string, Promise<unknown>>();
  constructor(
    private readonly home: string,
    private readonly authority: MentionAuthority,
  ) {}

  private async exclusive<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(agentId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    this.lanes.set(agentId, operation);
    try {
      return await operation;
    } finally {
      if (this.lanes.get(agentId) === operation) this.lanes.delete(agentId);
    }
  }

  private directory(agentId: string) {
    return join(
      this.home,
      "chi",
      "mentions-v3",
      createHash("sha256").update(agentId).digest("hex"),
    );
  }
  private path(agentId: string, messageId: string) {
    return join(
      this.directory(agentId),
      `${createHash("sha256").update(messageId).digest("hex")}.json`,
    );
  }
  private async receipts(agentId: string): Promise<Receipt[]> {
    let files: string[];
    try {
      files = await readdir(this.directory(agentId));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const receipts: Receipt[] = [];
    for (const file of files.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      receipts.push(
        receiptSchema.parse(await readConversationReceipt(join(this.directory(agentId), file))),
      );
    }
    return receipts;
  }
  private matches(receipt: Receipt, identity: MentionIdentity) {
    return (
      receipt.repo === identity.repo &&
      receipt.actor === identity.actor &&
      receipt.deployment === identity.deployment &&
      receipt.endpoint === this.authority.endpoint
    );
  }
  private async call(
    identity: MentionIdentity,
    path: string,
    method = "GET",
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(identity, path, method, body, query);
      } catch (error) {
        // Concurrent read markers move the repository fence. Reacquire GETs only;
        // saved mutation identities and their explicit retry flow remain authoritative.
        if (
          method !== "GET" ||
          attempt >= 2 ||
          !(error instanceof Error) ||
          error.message !== "chi-mentions-http-409"
        )
          throw error;
      }
    }
  }
  private async request(
    identity: MentionIdentity,
    path: string,
    method: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const url = append(endpointUrl(this.authority.endpoint), path);
    if (query) url.search = new URLSearchParams(query).toString();
    const response = await this.authority.request(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        authorization: `Bearer ${identity.token}`,
        "x-chi-repo": identity.repo,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (path === "handoffs/inbox" && response.status === 400) {
        const error = await boundedText(response, 4096)
          .then((text) => JSON.parse(text))
          .catch(() => null);
        if (error?.reason === "invalid-cursor") throw new Error("chi-inbox-invalid-cursor");
      }
      await response.body?.cancel();
      throw new Error(`chi-mentions-http-${response.status}`);
    }
    try {
      return parseJson(await boundedText(response, 1024 * 1024));
    } catch {
      throw new Error("chi-mention-invalid-response");
    }
  }
  private async participants(identity: MentionIdentity) {
    const result = participantsSchema.parse(await this.call(identity, "participants"));
    if (result.self.toLowerCase() !== identity.actor) throw new Error("chi-identity-mismatch");
    return result.participants.map((p) => ({ handle: p.handle, ownerId: p.ownerId.toLowerCase() }));
  }

  async prepare(input: {
    agentId: string;
    messageId: string;
    text: string;
    recipients: string[];
    identity: MentionIdentity;
    admission: string;
  }) {
    return this.exclusive(input.agentId, async () => {
      const recipients = [...new Set(input.recipients.map((id) => id.toLowerCase()))].sort();
      const path = this.path(input.agentId, input.messageId);
      const previous = await readConversationReceipt(path);
      if (previous !== null) {
        const receipt = receiptSchema.parse(previous);
        const sameRecipients =
          JSON.stringify(receipt.deliveries.map((d) => d.recipient.ownerId)) ===
          JSON.stringify(recipients);
        if (
          !this.matches(receipt, input.identity) ||
          receipt.text !== input.text ||
          !sameRecipients
        )
          throw new Error("chi-mention-conflict");
        if (receipt.admission && receipt.admission !== input.admission)
          throw new Error("chi-mention-conflict");
        if (!receipt.admission)
          await writeConversationReceipt(path, { ...receipt, admission: input.admission });
        return;
      }
      if (Buffer.byteLength(input.text) > 8000) throw new Error("chi-mention-text-too-long");
      const directory = await this.participants(input.identity);
      const selected: ChiParticipant[] = recipients.map((ownerId) => {
        const participant = directory.find((p) => p.ownerId === ownerId);
        if (!participant || !hasMention(input.text, participant.handle))
          throw new Error("chi-mention-recipient-unavailable");
        return participant;
      });
      if ((await this.receipts(input.agentId)).length >= 100)
        throw new Error("chi-mention-delivery-limit");
      const receipt: Receipt = {
        version: 3,
        agentId: input.agentId,
        messageId: input.messageId,
        repo: input.identity.repo,
        actor: input.identity.actor,
        endpoint: this.authority.endpoint,
        deployment: input.identity.deployment,
        text: input.text,
        admission: input.admission,
        source: null,
        deliveries: selected.map((recipient) => ({
          messageId: input.messageId,
          recipient,
          handoffId: randomUUID(),
          status: "pending",
          error: null,
        })),
      };
      await mkdir(this.directory(input.agentId), { recursive: true, mode: 0o700 });
      await publishConversationReceipt(path, receipt);
    });
  }

  async captured(input: {
    agentId: string;
    identity: MentionIdentity;
    pin: Pin;
    messages: CapturedMessage[];
  }) {
    input = {
      ...input,
      identity: { ...input.identity },
      pin: parsePin(input.pin),
      messages: input.messages.flatMap((message) => {
        const parsed = userMessage.safeParse(message.payload);
        return parsed.success
          ? [
              {
                id: message.id,
                seq: message.seq,
                payload: { type: "user", text: parsed.data.text, metadata: parsed.data.metadata },
              },
            ]
          : [];
      }),
    };
    if (
      input.pin.repo !== input.identity.repo ||
      input.pin.deployment !== input.identity.deployment
    )
      throw new Error("chi-mention-invalid-response");
    return this.exclusive(input.agentId, async () => {
      for (const receipt of await this.receipts(input.agentId)) {
        if (!this.matches(receipt, input.identity)) continue;
        if (!(await this.admitted(receipt))) continue;
        if (receipt.deliveries.every((d) => d.status === "delivered")) continue;
        if (!receipt.source) {
          const matches = input.messages.filter((message) => {
            const parsed = userMessage.safeParse(message.payload);
            if (!parsed.success || parsed.data.metadata.paseoClientMessageId !== receipt.messageId)
              return false;
            return parsed.data.text === receipt.text;
          });
          if (matches.length !== 1) {
            receipt.deliveries = receipt.deliveries.map((d) => ({
              ...d,
              status: "failed",
              error: "chi-mention-persisted-entry-required",
            }));
            await writeConversationReceipt(this.path(receipt.agentId, receipt.messageId), receipt);
            continue;
          }
          const selected = matches[0]!;
          try {
            receipt.source = await this.confirmSource({
              identity: input.identity,
              pin: input.pin,
              selected,
              receipt,
            });
          } catch (error) {
            for (const delivery of receipt.deliveries) {
              delivery.status = "failed";
              delivery.error = mentionFailure(error);
            }
            await writeConversationReceipt(this.path(receipt.agentId, receipt.messageId), receipt);
            continue;
          }
          // Commit the exact selected snapshot before sending. Lost HTTP replies never select a newer head.
          await writeConversationReceipt(this.path(receipt.agentId, receipt.messageId), receipt);
        }
        await this.deliver(receipt, input.identity);
      }
    });
  }
  private async confirmSource(input: {
    identity: MentionIdentity;
    pin: Pin;
    selected: CapturedMessage;
    receipt: Receipt;
  }): Promise<ChiSource> {
    const { selected, pin, receipt, identity } = input;
    if (!Number.isSafeInteger(selected.seq) || selected.seq < 0 || selected.seq >= pin.count)
      throw new Error("chi-mention-invalid-response");
    const exact = z.object({ entries: z.array(z.string()).length(1) }).parse(
      await this.call(identity, "evidence/exact", "GET", undefined, {
        pin: JSON.stringify(pin),
        start: String(selected.seq),
      }),
    );
    const entry = decodeEntry(exact.entries[0]!);
    if (entry.kind !== "message" || entry.seq !== selected.seq)
      throw new Error("chi-mention-invalid-response");
    const payload = z.object({ native: z.string() }).strict().parse(entry.payload);
    const archived = userMessage
      .extend({ id: z.literal(selected.id) })
      .parse(parseNativeJson(payload.native));
    if (
      archived.text !== receipt.text ||
      archived.metadata.paseoClientMessageId !== receipt.messageId
    )
      throw new Error("chi-mention-persisted-entry-required");
    return sourceView({ pin, seq: selected.seq });
  }
  private async deliver(receipt: Receipt, identity: MentionIdentity) {
    if (!(await this.admitted(receipt))) return;
    if (!receipt.source) return;
    for (const delivery of receipt.deliveries) {
      if (delivery.status === "delivered") continue;
      try {
        await this.createHandoff(identity, {
          id: delivery.handoffId,
          recipient: delivery.recipient.ownerId,
          text: receipt.text,
          sources: [receipt.source],
        });
        delivery.status = "delivered";
        delivery.error = null;
      } catch (error) {
        delivery.status = "failed";
        delivery.error = mentionFailure(error);
      }
      await writeConversationReceipt(this.path(receipt.agentId, receipt.messageId), receipt);
    }
  }
  async createHandoff(
    identity: MentionIdentity,
    input: {
      id: string;
      recipient: string;
      text: string;
      sources: z.infer<typeof ChiSourceSchema>[];
    },
  ) {
    if (Buffer.byteLength(input.text) > 8000) throw new Error("chi-mention-text-too-long");
    const sources = input.sources.map((source) => {
      if (source.kind !== "neutral" || !source.appendRef) throw new Error("chi-native-v3-required");
      const ref = source.appendRef;
      if (
        ref.pin.repo !== identity.repo ||
        ref.pin.deployment !== identity.deployment ||
        ref.seq >= ref.pin.count
      )
        throw new Error("chi-mention-invalid-response");
      return ref;
    });
    const response = handoffSchema
      .extend({ replay: z.boolean() })
      .parse(await this.call(identity, "handoffs", "POST", { ...input, v: 3, sources }));
    const handoff = handoffView(response.handoff, identity);
    if (
      handoff.id !== input.id ||
      handoff.author !== identity.actor ||
      handoff.recipient !== input.recipient ||
      handoff.repo !== identity.repo ||
      handoff.text !== input.text ||
      canonicalJson(response.handoff.sources) !== canonicalJson(sources)
    )
      throw new Error("chi-mention-invalid-response");
    return handoff;
  }
  async retry(agentId: string, identity: MentionIdentity) {
    return this.exclusive(agentId, async () => {
      let needsCapture = false;
      for (const receipt of await this.receipts(agentId)) {
        if (!this.matches(receipt, identity)) continue;
        if (!(await this.admitted(receipt))) continue;
        if (!receipt.source) needsCapture = true;
        else await this.deliver(receipt, identity);
      }
      return needsCapture;
    });
  }
  private async admitted(receipt: Receipt) {
    if (!receipt.admission) return false;
    return new MessageReceipts(join(this.home, "agent-requests")).admits(
      receipt.agentId,
      receipt.messageId,
      receipt.admission,
    );
  }
  async status(agentId: string, identity: MentionIdentity): Promise<ChiMentionResult> {
    const receipts = await this.receipts(agentId);
    return {
      kind: "delivery",
      actor: identity.actor,
      deliveries: receipts.filter((r) => this.matches(r, identity)).flatMap((r) => r.deliveries),
    };
  }
  async execute(
    identity: MentionIdentity,
    operation: Exclude<ChiMentionOperation, { action: "delivery" | "retry" | "scope" }>,
  ): Promise<ChiMentionResult> {
    const actor = identity.actor;
    if (
      operation.action === "reply" ||
      operation.action === "acknowledge" ||
      operation.action === "list"
    )
      throw new Error("chi-operation-unsupported");
    if (operation.action === "participants")
      return { kind: "participants", actor, participants: await this.participants(identity) };
    if (operation.action === "inbox") return this.inbox(identity, operation);
    let result;
    if (operation.action === "viewed") {
      result = await this.call(identity, "handoffs/read", "POST", {
        v: 3,
        id: operation.id,
        revision: operation.revision,
      });
    } else {
      result = await this.call(identity, "handoffs", "GET", undefined, { id: operation.id });
    }
    const handoff = handoffView(handoffSchema.parse(result).handoff, identity);
    if (handoff.id !== operation.id || handoff.repo !== identity.repo)
      throw new Error("chi-mention-invalid-response");
    if (operation.action !== "source" && operation.action !== "context")
      return { kind: "handoff", actor, handoff };
    const source = handoff.sources[operation.index];
    if (!source || source.kind !== "neutral" || !source.appendRef)
      throw new Error("chi-mention-native-source-required");
    return this.readSource(identity, source, operation);
  }
  private async readSource(
    identity: MentionIdentity,
    source: Extract<ChiSource, { kind: "neutral" }>,
    operation: Extract<ChiMentionOperation, { action: "source" | "context" }>,
  ): Promise<ChiMentionResult> {
    const actor = identity.actor;
    const ref = source.appendRef;
    if (!ref) throw new Error("chi-mention-native-source-required");
    if (operation.action === "context") {
      const cursor = operation.cursor?.split(":");
      if (
        cursor &&
        (cursor.length !== 2 || cursor[0] !== ref.pin.head || !/^(0|[1-9][0-9]*)$/.test(cursor[1]!))
      )
        throw new Error("chi-mention-invalid-cursor");
      const start = cursor ? Number(cursor[1]) : 0;
      if (!Number.isSafeInteger(start) || start > ref.pin.count)
        throw new Error("chi-mention-invalid-cursor");
      // V3 complete-entry witnesses are below 100 KiB; eight entries leave
      // response framing room under the strict 1 MiB decoder boundary.
      const end = Math.min(start + 8, ref.pin.count);
      const page = z.object({ entries: z.array(z.string()).max(30) }).parse(
        await this.call(identity, "evidence/entries", "GET", undefined, {
          pin: JSON.stringify(ref.pin),
          start: String(start),
          end: String(end),
        }),
      );
      if (page.entries.length !== end - start) throw new Error("chi-mention-invalid-response");
      const entries = page.entries.map((bytes, index) => {
        const entry = decodeEntry(bytes);
        if (entry.seq !== start + index) throw new Error("chi-mention-invalid-response");
        const payload = z.object({ native: z.string() }).parse(entry.payload);
        const native = z
          .object({ id: z.string(), type: z.string().optional() })
          .parse(parseNativeJson(payload.native));
        return {
          nativeId: native.id,
          type: entry.kind === "message" ? (native.type ?? "message") : entry.kind,
          seq: entry.seq,
        };
      });
      return {
        kind: "context",
        actor,
        source,
        entries,
        nextCursor: end < ref.pin.count ? `${ref.pin.head}:${end}` : null,
      };
    }
    if (operation.entryId !== undefined) throw new Error("chi-mention-invalid-source");
    const seq = operation.seq ?? ref.seq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq >= ref.pin.count)
      throw new Error("chi-mention-invalid-source");
    const exact = z.object({ entries: z.array(z.string()).length(1) }).parse(
      await this.call(identity, "evidence/exact", "GET", undefined, {
        pin: JSON.stringify(ref.pin),
        start: String(seq),
      }),
    );
    const entry = decodeEntry(exact.entries[0]!);
    if (entry.seq !== seq) throw new Error("chi-mention-invalid-response");
    const native = z.object({ native: z.string() }).parse(entry.payload);
    const payload = JSON.stringify(parseNativeJson(native.native), null, 2);
    if (payload.length > 1024 * 1024) throw new Error("chi-mention-source-too-large");
    return {
      kind: "source",
      actor,
      source: sourceView({ pin: ref.pin, seq }),
      payload,
    };
  }
  private async inbox(
    identity: MentionIdentity,
    operation: Extract<ChiMentionOperation, { action: "inbox" }>,
  ): Promise<ChiMentionResult> {
    const result = z
      .object({
        handoffs: z.array(handoffWireSchema),
        nextCursor: z.string().nullable(),
        unreadCount: z.number().int().nonnegative(),
        unreadCountLowerBound: z.boolean(),
      })
      .parse(
        await this.call(identity, "handoffs/inbox", "GET", undefined, {
          inbox: operation.inbox ? "received" : "sent",
          cursor: operation.cursor ?? "",
        }),
      );
    if (
      operation.inbox &&
      result.handoffs.some((h) => h.recipient.toLowerCase() !== identity.actor)
    )
      throw new Error("chi-mention-invalid-response");
    return {
      kind: "inbox",
      actor: identity.actor,
      handoffs: result.handoffs.map((handoff) => handoffView(handoff, identity)),
      nextCursor: result.nextCursor,
      unreadCount: result.unreadCount,
      unreadCountIsLowerBound: result.unreadCountLowerBound,
    };
  }
}

export function hasMention(text: string, handle: string): boolean {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s(])@${escaped}(?=$|[\\s),.!?:;])`, "i").test(text);
}
