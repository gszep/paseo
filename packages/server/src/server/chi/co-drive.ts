import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  CoDriveViewSchema,
  CoDriveSendSchema,
  type CoDriveGrant,
  type CoDriveSend,
} from "@getpaseo/protocol/chi-mentions";
import type { Pin } from "@henkaku-center/chi-native/append-codec";
import {
  publishConversationReceipt,
  readConversationReceipt,
} from "@henkaku-center/chi-native/conversations";
import { mkdir } from "node:fs/promises";
import { MessageReceipts } from "../message-receipts/index.js";
import { confirmsNativeSubmission } from "../message-receipts/native.js";

export interface ControlSource {
  agentId: string;
  sourceId: string;
  repo: string;
  endpoint: string;
  actor: string;
  instanceId: string;
  nativeSessionId: string;
  cwd: string;
  pin: Pin;
  discoveryGeneration?: number;
}
interface DriverHooks {
  source(agentId: string): Promise<ControlSource>;
  call(
    source: ControlSource,
    request?: Record<string, unknown>,
    operationId?: string,
  ): Promise<unknown>;
  verify(source: ControlSource, grant: CoDriveGrant): Promise<void>;
  capture(agentId: string): Promise<ControlSource>;
  native(source: ControlSource): Promise<unknown>;
  busy(agentId: string): boolean;
  canStart(agentId: string): boolean;
  disable(source: ControlSource): Promise<void>;
  /** Runs inside the existing manager admission lane, immediately before native start. */
  run(source: ControlSource, operation: CoDriveSend, admit: () => Promise<void>): Promise<void>;
}

/** One source operation at a time, using the normal native message receipts.
 * Backend admission is the linearization point. No pairing, host management,
 * steering, approval or native session-creation capability crosses this API. */
export class CoDriveDriver {
  private readonly receipts: MessageReceipts;
  constructor(
    private readonly home: string,
    private readonly hooks: DriverHooks,
  ) {
    this.receipts = new MessageReceipts(join(home, "agent-requests"));
  }
  async tick(agentId: string): Promise<void> {
    if (this.hooks.busy(agentId)) return;
    let source = await this.hooks.source(agentId);
    const view = CoDriveViewSchema.parse(await this.hooks.call(source));
    if (view.ownerId !== source.actor || view.sourceId !== source.sourceId)
      throw new Error("chi-control-owner-required");
    const operation = view.operation;
    if (!view.control || (!view.control.active && operation?.phase !== "admitted")) {
      await this.hooks.disable(source);
      return;
    }
    // Error lifecycle still permits proof-only reconciliation of an already
    // admitted input. It never advertises readiness or admits another send.
    if (operation?.phase !== "admitted" && !this.hooks.canStart(agentId)) return;
    source = await this.hooks.capture(agentId);
    if (operation?.phase !== "admitted") await this.hooks.verify(source, view.control);
    if (!operation) {
      await this.hooks.call(source, {
        action: "announce",
        generation: view.control.generation,
        contextDigest: view.control.contextDigest,
        expectedPin: source.pin,
        available: true,
      });
      return;
    }
    const text = operation.text;
    if (text === null) throw new Error("chi-control-recovery-required");
    const messageId = `co-drive:${operation.id}`;
    const claim = await this.claim(source, operation);
    const admitted = async () => {
      const current = await this.hooks.source(agentId);
      if (
        current.sourceId !== source.sourceId ||
        current.endpoint !== source.endpoint ||
        current.actor !== source.actor ||
        current.nativeSessionId !== source.nativeSessionId
      )
        throw new Error("chi-control-context-changed");
      const fresh = CoDriveViewSchema.parse(await this.hooks.call(current));
      if (
        !fresh.control ||
        !fresh.control.active ||
        fresh.control.generation !== operation.generation ||
        fresh.control.contextDigest !== operation.contextDigest ||
        fresh.operation?.id !== operation.id ||
        fresh.operation.digest !== operation.digest
      )
        throw new Error("chi-control-context-changed");
      await this.hooks.verify(current, fresh.control);
      const result = z
        .object({ operation: CoDriveSendSchema, executionGranted: z.boolean() })
        .parse(
          await this.hooks.call(current, {
            action: "admit",
            id: operation.id,
            generation: operation.generation,
            contextDigest: operation.contextDigest,
            admissionId: claim.admissionId,
          }),
        );
      if (!result.executionGranted) throw new Error("chi-control-recovery-required");
    };
    try {
      await this.receipts.send({
        durable: true,
        agentId,
        messageId,
        request: {
          endpoint: source.endpoint,
          actor: source.actor,
          sourceId: source.sourceId,
          operation: operation.id,
          digest: operation.digest,
        },
        prepare: async () => {
          if (operation.phase !== "queued") throw new Error("chi-control-recovery-required");
        },
        send: () => this.hooks.run(source, operation, admitted),
        recover: async () =>
          confirmsNativeSubmission({
            native: await this.hooks.native(source),
            sessionId: source.nativeSessionId,
            cwd: source.cwd,
            messageId,
            text,
          }),
      });
    } catch (error) {
      // Definitive rejection wins a CAS against admission. Unknown/admitted
      // outcomes stay pending; they never become a second native send.
      const fresh = CoDriveViewSchema.parse(await this.hooks.call(source, undefined, operation.id));
      if (fresh.operation?.phase === "queued")
        await this.hooks.call(source, { action: "cancel", id: operation.id });
      throw error;
    }
    if (this.hooks.busy(agentId)) return;
    await this.record(await this.hooks.capture(agentId), operation, claim.admissionId);
  }

  private async claim(source: ControlSource, operation: CoDriveSend) {
    const directory = join(this.home, "chi", "receipts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // A random claim ID is private operation identity, never a recipient token.
    const claimPath = join(directory, `co-drive-${operation.id}.json`);
    await publishConversationReceipt(claimPath, {
      sourceId: source.sourceId,
      endpoint: source.endpoint,
      actor: source.actor,
      operation: operation.id,
      admissionId: randomUUID(),
      digest: operation.digest,
    });
    const claim = z
      .object({
        sourceId: z.string(),
        endpoint: z.string(),
        actor: z.string(),
        operation: z.string(),
        admissionId: z.string().uuid(),
        digest: z.string(),
      })
      .strict()
      .parse(await readConversationReceipt(claimPath));
    if (
      claim.sourceId !== source.sourceId ||
      claim.endpoint !== source.endpoint ||
      claim.actor !== source.actor ||
      claim.operation !== operation.id ||
      claim.digest !== operation.digest
    )
      throw new Error("chi-control-recovery-required");
    return claim;
  }

  private async record(source: ControlSource, operation: CoDriveSend, admissionId: string) {
    const text = operation.text;
    if (text === null) throw new Error("chi-control-recovery-required");
    const messageId = `co-drive:${operation.id}`;
    const directory = join(this.home, "chi", "receipts");
    const native = await this.hooks.native(source);
    if (
      !confirmsNativeSubmission({
        native,
        sessionId: source.nativeSessionId,
        cwd: source.cwd,
        messageId,
        text,
      })
    )
      throw new Error("chi-control-recovery-required");
    const exported = z
      .object({
        messages: z.array(
          z.object({ id: z.string(), metadata: z.record(z.string(), z.unknown()).optional() }),
        ),
      })
      .parse(native);
    const nativeId = exported.messages.find(
      (message) => message.metadata?.paseoClientMessageId === messageId,
    )!.id;
    const ackPath = join(directory, `co-drive-${operation.id}-record.json`);
    await publishConversationReceipt(ackPath, {
      action: "record",
      id: operation.id,
      admissionId,
      pin: source.pin,
      nativeId,
    });
    const ack = z
      .object({
        action: z.literal("record"),
        id: z.string(),
        admissionId: z.string(),
        pin: z.unknown(),
        nativeId: z.string(),
      })
      .strict()
      .parse(await readConversationReceipt(ackPath));
    if (ack.id !== operation.id || ack.admissionId !== admissionId || ack.nativeId !== nativeId)
      throw new Error("chi-control-recovery-required");
    await this.hooks.call(source, ack);
  }
}
