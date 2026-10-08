import { z } from "zod";

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const principal = z.string().regex(/^github:[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/);
const text = z.string().min(1).max(8000);
export const ChiMentionContextSchema = z.object({
  actor: principal,
  repo: id,
  generation: hash,
  deployment: z.string().optional(),
  evidenceVersion: z.literal(3).optional(),
  repositories: z.array(id).optional(),
});
export type ChiMentionContext = z.infer<typeof ChiMentionContextSchema>;
export const ChiFailureSchema = z.object({
  accessLost: z.boolean(),
  outcome: z.enum(["not_committed", "unknown"]),
});
export type ChiFailure = z.infer<typeof ChiFailureSchema>;

export class ChiOperationError extends Error {
  constructor(
    message: string,
    public readonly failure?: ChiFailure,
  ) {
    super(message);
    this.name = "ChiOperationError";
  }
}
export const ChiParticipantSchema = z.object({ ownerId: principal, handle: id });
export type ChiParticipant = z.infer<typeof ChiParticipantSchema>;
export const ChiMentionRecipientsSchema = z.array(principal).min(1).max(8);
export const ChiPinSchema = z.object({
  v: z.literal(3),
  deployment: id,
  repo: id,
  sourceId: hash,
  count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  head: hash,
});
export const ChiEntryRefSchema = z.object({
  pin: ChiPinSchema,
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type ChiEntryRef = z.infer<typeof ChiEntryRefSchema>;
export const ChiSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("neutral"),
    id,
    snapshot: hash,
    entryId: id,
    appendRef: ChiEntryRefSchema.optional(),
  }),
  z.object({ kind: z.literal("session"), id, entryId: id.optional() }),
  z.object({ kind: z.literal("artifact"), id, entryId: id.optional() }),
]);
export type ChiSource = z.infer<typeof ChiSourceSchema>;
const state = z.enum(["open", "acknowledged", "working", "resolved", "declined"]);
export const ChiHandoffSchema = z.object({
  schemaVersion: z.literal(1),
  evidenceVersion: z.literal(3).optional(),
  id: z.string().uuid(),
  repo: id,
  author: principal,
  recipient: principal,
  text,
  sources: z.array(ChiSourceSchema).min(1).max(32),
  state,
  revision: z.number().int().positive(),
  createdAt: id,
  updatedAt: id,
  readAt: id.optional(),
  humanPromptControls: z.boolean().optional(),
  events: z.array(
    z.object({ actor: principal, state, at: id, revision: z.number().int().positive() }),
  ),
  resolution: z
    .discriminatedUnion("incomplete", [
      z.object({ incomplete: z.literal(true), text }),
      z.object({
        incomplete: z.literal(false),
        text,
        result: ChiSourceSchema,
        check: ChiSourceSchema,
      }),
    ])
    .optional(),
  replies: z
    .array(
      z.object({
        id: z.string().uuid(),
        actor: principal,
        text,
        at: id,
        revision: z.number().int().positive(),
      }),
    )
    .max(50)
    .optional(),
});
export type ChiHandoff = z.infer<typeof ChiHandoffSchema>;

// These envelopes travel as ordinary scanned handoff/reply text. They convey
// provenance, not authority; readers still verify the authenticated reply actor.
const promptItem = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["question", "approval", "decision", "note"]),
    priority: z.enum(["blocking", "fyi"]),
    text: z.string().min(1).max(2000),
  })
  .strict();
export const HumanPromptBatchSchema = z
  .object({
    sessionId: id,
    turnId: id,
    items: z.array(promptItem).min(1).max(5),
  })
  .strict();
export type HumanPromptBatch = z.infer<typeof HumanPromptBatchSchema>;
const promptPrefix = "Agent-initiated human prompts (v1)\n";
const answerPrefix = "Human prompt answers (v1)\n";
const answerSchema = z
  .object({
    answers: z
      .array(z.object({ id: z.string().uuid(), text: z.string().min(1).max(2000) }).strict())
      .min(1)
      .max(5),
  })
  .strict();
export function encodeHumanPrompts(batch: HumanPromptBatch): string {
  const value = promptPrefix + JSON.stringify(HumanPromptBatchSchema.parse(batch));
  if (value.length > 8000) throw new Error("chi-human-prompt-batch-limit");
  return value;
}
export function readHumanPrompts(value: string): HumanPromptBatch | null {
  if (!value.startsWith(promptPrefix) || value.length > 8000) return null;
  try {
    return HumanPromptBatchSchema.parse(JSON.parse(value.slice(promptPrefix.length)));
  } catch {
    return null;
  }
}
export function encodeHumanAnswers(answers: Array<{ id: string; text: string }>): string {
  const value = answerPrefix + JSON.stringify(answerSchema.parse({ answers }));
  if (value.length > 8000) throw new Error("chi-human-prompt-batch-limit");
  return value;
}
export function readHumanAnswers(value: string): Array<{ id: string; text: string }> {
  if (!value.startsWith(answerPrefix) || value.length > 8000) return [];
  try {
    const { answers } = answerSchema.parse(JSON.parse(value.slice(answerPrefix.length)));
    return new Set(answers.map((a) => a.id)).size === answers.length ? answers : [];
  } catch {
    return [];
  }
}
export const ChiDeliverySchema = z.object({
  messageId: id,
  recipient: ChiParticipantSchema,
  handoffId: z.string().uuid(),
  status: z.enum(["pending", "delivered", "failed"]),
  error: z.string().nullable(),
});
export type ChiDelivery = z.infer<typeof ChiDeliverySchema>;
export const ChiMentionOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("scope"), includeRepositories: z.boolean().optional() }),
  z.object({ action: z.literal("participants") }),
  z.object({
    action: z.literal("inbox"),
    inbox: z.boolean(),
    repo: id.optional(),
    cursor: z.string().max(4096).optional(),
  }),
  z.object({
    action: z.literal("list"),
    inbox: z.boolean(),
    offset: z.number().int().nonnegative(),
  }),
  z.object({ action: z.literal("read"), id: z.string().uuid(), repo: id.optional() }),
  z.object({
    action: z.literal("viewed"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    repo: id.optional(),
  }),
  z.object({
    action: z.literal("source"),
    repo: id.optional(),
    id: z.string().uuid(),
    index: z.number().int().min(0).max(31),
    entryId: id.optional(),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  z.object({
    action: z.literal("context"),
    repo: id.optional(),
    id: z.string().uuid(),
    index: z.number().int().min(0).max(31),
    cursor: z.string().max(4096).optional(),
  }),
  z.object({
    action: z.literal("acknowledge"),
    repo: id.optional(),
    id: z.string().uuid(),
    operationId: z.string().uuid(),
    revision: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("reply"),
    repo: id.optional(),
    id: z.string().uuid(),
    operationId: z.string().uuid(),
    revision: z.number().int().positive(),
    text,
  }),
  z.object({ action: z.literal("delivery"), agentId: id }),
  z.object({ action: z.literal("retry"), agentId: id }),
]);
export type ChiMentionOperation = z.infer<typeof ChiMentionOperationSchema>;
export const ChiMentionResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scope"), actor: principal }),
  z.object({
    kind: z.literal("inbox"),
    actor: principal,
    handoffs: z.array(ChiHandoffSchema),
    nextCursor: z.string().nullable(),
    unreadCount: z.number().int().nonnegative(),
    unreadCountIsLowerBound: z.boolean().optional(),
    unavailableRepos: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("participants"),
    actor: principal,
    participants: z.array(ChiParticipantSchema),
  }),
  z.object({
    kind: z.literal("list"),
    actor: principal,
    handoffs: z.array(ChiHandoffSchema),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
  z.object({ kind: z.literal("handoff"), actor: principal, handoff: ChiHandoffSchema }),
  z.object({
    kind: z.literal("source"),
    actor: principal,
    source: ChiSourceSchema,
    payload: z.string().max(1024 * 1024),
    origin: z.object({ hostId: id, sessionId: id }).optional(),
  }),
  z.object({
    kind: z.literal("context"),
    actor: principal,
    source: ChiSourceSchema,
    entries: z
      .array(z.object({ nativeId: id, type: id, seq: z.number().int().nonnegative().optional() }))
      .max(30),
    nextCursor: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("delivery"),
    actor: principal,
    deliveries: z.array(ChiDeliverySchema),
  }),
]);
export type ChiMentionResult = z.infer<typeof ChiMentionResultSchema>;
export const ChiMentionRequestSchema = z.object({
  type: z.literal("chi.mentions.execute.request"),
  requestId: z.string(),
  workspaceId: id.optional(),
  operation: ChiMentionOperationSchema,
  expectedContext: ChiMentionContextSchema.optional(),
});
export const ChiMentionResponseSchema = z.object({
  type: z.literal("chi.mentions.execute.response"),
  payload: z.discriminatedUnion("outcome", [
    z.object({
      requestId: z.string(),
      outcome: z.literal("ready"),
      result: ChiMentionResultSchema,
      context: ChiMentionContextSchema.optional(),
    }),
    z.object({
      requestId: z.string(),
      outcome: z.literal("failed"),
      error: z.string(),
      failure: ChiFailureSchema.optional(),
    }),
  ]),
});
