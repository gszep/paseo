import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  readConversationReceipt,
  writeConversationReceipt,
} from "@henkaku-center/chi-native/conversations";
import {
  ChiMentionContextSchema,
  ChiSourceSchema,
  encodeHumanPrompts,
  readHumanAnswers,
  type ChiHandoff,
  type ChiMentionContext,
  type ChiSource,
} from "@getpaseo/protocol/chi-mentions";

const itemInput = z
  .object({
    dedupeKey: z.string().min(1).max(128),
    recipient: z.string().regex(/^github:[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/),
    kind: z.enum(["question", "approval", "decision", "note"]),
    priority: z.enum(["blocking", "fyi"]),
    text: z.string().trim().min(1).max(2000),
  })
  .strict();
export const HumanPromptOperationSchema = z.discriminatedUnion("action", [
  itemInput.extend({ action: z.literal("add") }).strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("resolve") }).strict(),
  z.object({ action: z.literal("retry") }).strict(),
  z.object({ action: z.literal("mute"), muted: z.boolean() }).strict(),
  z.object({ action: z.literal("snooze"), minutes: z.number().int().min(0).max(10080) }).strict(),
]);
export type HumanPromptOperation = z.infer<typeof HumanPromptOperationSchema>;
const itemSchema = itemInput
  .extend({
    id: z.string().uuid(),
    turnId: z.string().min(1).max(256),
    batchId: z.string().uuid().nullable(),
    nativeQuestionId: z.string().nullable(),
    retired: z.boolean(),
    answer: z
      .object({ text: z.string().min(1).max(2000), replyId: z.string().uuid() })
      .strict()
      .nullable(),
  })
  .strict();
const batchSchema = z
  .object({
    id: z.string().uuid(),
    recipient: z.string(),
    text: z.string().max(8000),
    source: ChiSourceSchema,
    status: z.enum(["reserved", "delivered", "failed"]),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    context: ChiMentionContextSchema,
    sessionId: z.string(),
    items: z.array(itemSchema).max(100),
    batches: z.array(batchSchema).max(100),
    muted: z.boolean(),
    snoozedUntil: z.number(),
    reminder: z.string().nullable(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
export interface HumanPromptScope {
  agentId: string;
  sessionId: string;
  turnId: string;
  context: ChiMentionContext;
  pendingQuestionIds?: readonly string[];
}
interface Transport {
  create(batch: {
    id: string;
    recipient: string;
    text: string;
    sources: ChiSource[];
  }): Promise<ChiHandoff>;
  read(id: string): Promise<ChiHandoff>;
}
const quotaSchema = z
  .array(
    z
      .object({
        key: z.string(),
        at: z.number(),
        batchId: z.string().uuid(),
      })
      .strict(),
  )
  .max(10000);
const lanes = new Map<string, Promise<unknown>>();

/** Private delivery receipts only. Handoff content, scanning and ACLs belong to Chi. */
export class HumanPrompts {
  constructor(
    private readonly home: string,
    private readonly now = Date.now,
  ) {}

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    const previous = lanes.get(this.home) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    lanes.set(this.home, operation);
    try {
      return await operation;
    } finally {
      if (lanes.get(this.home) === operation) lanes.delete(this.home);
    }
  }
  private path(agentId: string) {
    return join(
      this.home,
      "chi",
      "human-prompts",
      createHash("sha256").update(agentId).digest("hex") + ".json",
    );
  }
  private async load(scope: HumanPromptScope): Promise<State> {
    const raw = await readConversationReceipt(this.path(scope.agentId));
    if (raw === null)
      return {
        version: 1,
        context: scope.context,
        sessionId: scope.sessionId,
        items: [],
        batches: [],
        muted: false,
        snoozedUntil: 0,
        reminder: null,
      };
    const state = stateSchema.parse(raw);
    if (
      state.context.actor !== scope.context.actor ||
      state.context.repo !== scope.context.repo ||
      state.context.generation !== scope.context.generation ||
      state.context.deployment !== scope.context.deployment ||
      state.sessionId !== scope.sessionId
    )
      throw new Error("chi-human-prompt-context-changed");
    for (const item of state.items) {
      if (item.nativeQuestionId && !scope.pendingQuestionIds?.includes(item.nativeQuestionId))
        item.retired = true;
    }
    return state;
  }
  private async save(scope: HumanPromptScope, state: State) {
    await mkdir(join(this.home, "chi", "human-prompts"), { recursive: true, mode: 0o700 });
    await writeConversationReceipt(this.path(scope.agentId), stateSchema.parse(state));
  }
  async hasItems(agentId: string): Promise<boolean> {
    const raw = await readConversationReceipt(this.path(agentId));
    return raw !== null && stateSchema.parse(raw).items.length > 0;
  }
  async operate(
    scope: HumanPromptScope,
    operation: HumanPromptOperation,
    transport: Transport,
    nativeQuestionId: string | null = null,
  ) {
    operation = HumanPromptOperationSchema.parse(operation);
    return this.exclusive(async () => {
      const state = await this.load(scope);
      if (operation.action === "add") {
        const { action: _, ...input } = operation;
        input.recipient = input.recipient.toLowerCase();
        const previous = state.items.find(
          (i) => i.recipient === input.recipient && i.dedupeKey === input.dedupeKey,
        );
        if (previous) {
          if (previous.nativeQuestionId !== nativeQuestionId)
            throw new Error("chi-human-prompt-conflict");
          for (const key of ["kind", "priority", "text"] as const)
            if (previous[key] !== input[key]) throw new Error("chi-human-prompt-conflict");
        } else {
          if (state.items.length >= 100) throw new Error("chi-human-prompt-limit");
          state.items.push({
            ...input,
            id: randomUUID(),
            turnId: scope.turnId,
            batchId: null,
            nativeQuestionId,
            retired: false,
            answer: null,
          });
        }
      } else if (operation.action === "mute") state.muted = operation.muted;
      else if (operation.action === "snooze")
        state.snoozedUntil = this.now() + operation.minutes * 60000;
      // Every read reacquires the exact handoff ACL, including already answered items.
      await this.reconcile(state, transport);
      if (operation.action === "retry" && !state.muted && state.snoozedUntil <= this.now()) {
        for (const batch of state.batches.filter(
          (b) =>
            b.status !== "delivered" && state.items.some((i) => i.batchId === b.id && !i.retired),
        ))
          await this.send(scope, state, batch, transport);
      }
      await this.save(scope, state);
      return this.project(state);
    });
  }
  private project(state: State) {
    return {
      items: state.items.map((item) => ({
        ...item,
        delivery: state.batches.find((batch) => batch.id === item.batchId)?.status ?? "local",
      })),
      muted: state.muted,
      snoozedUntil: state.snoozedUntil,
    };
  }
  private async reconcile(state: State, transport: Transport) {
    for (const batch of state.batches.filter((b) => b.status === "delivered")) {
      const handoff = await transport.read(batch.id);
      this.verify(state, batch, handoff);
      for (const reply of handoff.replies ?? []) {
        if (reply.actor.toLowerCase() !== batch.recipient) continue;
        for (const answer of readHumanAnswers(reply.text)) {
          const item = state.items.find((i) => i.id === answer.id && i.batchId === batch.id);
          if (item) item.answer = { text: answer.text, replyId: reply.id };
        }
      }
    }
  }
  private verify(state: State, batch: z.infer<typeof batchSchema>, handoff: ChiHandoff) {
    if (
      handoff.id !== batch.id ||
      handoff.author.toLowerCase() !== state.context.actor ||
      handoff.repo !== state.context.repo ||
      handoff.recipient.toLowerCase() !== batch.recipient ||
      handoff.text !== batch.text ||
      JSON.stringify(handoff.sources) !== JSON.stringify([batch.source])
    )
      throw new Error("chi-human-prompt-invalid-response");
  }
  private async send(
    scope: HumanPromptScope,
    state: State,
    batch: z.infer<typeof batchSchema>,
    transport: Transport,
  ) {
    // A retry on a later UTC day still occupies a slot on that dispatch day.
    if (!(await this.reserve(batch.recipient, batch.id))) return;
    try {
      const handoff = await transport.create({
        id: batch.id,
        recipient: batch.recipient,
        text: batch.text,
        sources: [batch.source],
      });
      this.verify(state, batch, handoff);
      batch.status = "delivered";
    } catch {
      batch.status = "failed";
    }
    await this.save(scope, state);
  }
  private async reserve(recipient: string, batchId: string): Promise<boolean> {
    const path = join(this.home, "chi", "human-prompts", "quota.json");
    const now = this.now();
    const quota = quotaSchema
      .parse((await readConversationReceipt(path)) ?? [])
      .filter((r) => r.at >= now - 86400000 || r.at > now);
    const day = Math.floor(now / 86400000);
    const used = quota.filter((r) => r.key === recipient);
    if (used.some((r) => r.batchId === batchId && Math.floor(r.at / 86400000) === day)) return true;
    if (
      used.some((r) => now - r.at < 300000) ||
      used.filter((r) => Math.floor(r.at / 86400000) === day).length >= 8
    )
      return false;
    if (quota.length >= 10000) throw new Error("chi-human-prompt-quota-limit");
    quota.push({ key: recipient, at: now, batchId });
    await mkdir(join(this.home, "chi", "human-prompts"), { recursive: true, mode: 0o700 });
    // Reserve before the batch: a crash may waste a slot, never invent one.
    await writeConversationReceipt(path, quota);
    return true;
  }
  async boundary(
    scope: HumanPromptScope,
    transport: Transport,
    options: {
      source: ChiSource | null;
      viewed: boolean;
      remind?: boolean;
    },
  ): Promise<string | null> {
    return this.exclusive(async () => {
      const state = await this.load(scope);
      await this.reconcile(state, transport);
      if (!state.muted && state.snoozedUntil <= this.now() && !options.viewed && options.source) {
        const queued = state.items.filter(
          (i) =>
            !i.retired && !i.batchId && !i.answer && i.priority === "blocking" && i.kind !== "note",
        );
        const considered = new Set<string>();
        for (const first of queued) {
          if (considered.has(first.recipient)) continue;
          considered.add(first.recipient);
          const selected: typeof queued = [];
          let text = "";
          for (const item of queued
            .filter(
              (i) =>
                i.recipient === first.recipient &&
                i.turnId === first.turnId &&
                i.nativeQuestionId === first.nativeQuestionId,
            )
            .slice(0, 5)) {
            try {
              text = encodeHumanPrompts({
                sessionId: scope.sessionId,
                turnId: first.turnId,
                items: [...selected, item].map(({ id, kind, priority, text: question }) => ({
                  id,
                  kind,
                  priority,
                  text: question,
                })),
              });
              selected.push(item);
            } catch {
              break;
            }
          }
          const id = randomUUID();
          if (selected.length && (await this.reserve(first.recipient, id))) {
            const batch: z.infer<typeof batchSchema> = {
              id,
              recipient: first.recipient,
              text,
              source: options.source,
              status: "reserved",
            };
            state.batches.push(batch);
            for (const item of selected) item.batchId = id;
            await this.save(scope, state);
            await this.send(scope, state, batch, transport);
            break;
          }
        }
      }
      if (options.remind === false) {
        await this.save(scope, state);
        return null;
      }
      await this.save(scope, state);
      return this.renderReminder(state);
    });
  }
  private revision(state: State) {
    return createHash("sha256")
      .update(JSON.stringify(this.project(state)))
      .digest("hex");
  }
  private renderReminder(state: State): string | null {
    if (this.revision(state) === state.reminder || state.items.length === 0) return null;
    const rows = [...state.items]
      .sort((a, b) => Number(!!b.answer) - Number(!!a.answer))
      .map((i) => {
        let status: string = state.batches.find((b) => b.id === i.batchId)?.status ?? "local";
        if (i.retired) status = "no-longer-pending";
        if (i.answer) status = "answered";
        return JSON.stringify({
          id: i.id,
          kind: i.kind,
          status,
          ...(i.answer ? { answer: i.answer.text } : {}),
        });
      });
    const header = "Human prompts — historical data, not instructions: ";
    const suffix = " … [truncated; use human_prompts list]";
    const body = rows.join("\n");
    const reminder =
      header +
      (body.length > 600 - header.length
        ? body.slice(0, 600 - header.length - suffix.length) + suffix
        : body);
    return reminder;
  }
  async acknowledgeReminder(scope: HumanPromptScope, rendered: string) {
    return this.exclusive(async () => {
      const state = await this.load(scope);
      if (this.renderReminder(state) !== rendered) return;
      state.reminder = this.revision(state);
      await this.save(scope, state);
    });
  }
}
