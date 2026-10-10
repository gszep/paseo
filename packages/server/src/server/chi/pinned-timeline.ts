import { z } from "zod";
import { decodeEntry, parseNativeJson, type Pin } from "@henkaku-center/chi-native/append-codec";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/timeline-item";
import type { ChiMentionResult } from "@getpaseo/protocol/chi-mentions";
import { V2Timeline } from "../agent/providers/opencode/v2/timeline.js";

// Validate the fields consumed by the ordinary V2 display mapper. This is a
// presentation boundary, not a write/import contract or a new minimisation pass.
const metadata = z.record(z.string(), z.json());
const created = z
  .number()
  .finite()
  .refine((value) => Number.isFinite(new Date(value).getTime()));
const base = z.object({
  id: z.string().min(1),
  type: z.string(),
  time: z.object({ created }).passthrough(),
  metadata: metadata.optional(),
});
const model = z.object({ id: z.string(), providerID: z.string(), variant: z.string().optional() });
const error = z.object({ type: z.string(), message: z.string(), status: z.number().optional() });
const content = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("file"),
    uri: z.string(),
    mime: z.string(),
    name: z.string().nullable().optional(),
  }),
]);
const output = z.tuple([content]).rest(content);
const toolState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("streaming"), input: z.string() }),
  z.object({ status: z.literal("running"), input: metadata, metadata }),
  z.object({
    status: z.literal("completed"),
    input: metadata,
    content: output,
    metadata: metadata.optional(),
  }),
  z.object({
    status: z.literal("error"),
    input: metadata,
    error,
    content: output.optional(),
    metadata: metadata.optional(),
  }),
]);
const assistantPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  z.object({
    type: z.literal("tool"),
    id: z.string(),
    name: z.string(),
    state: toolState,
    time: z.object({ created }),
  }),
]);
const displayMessage = z.union([
  base.extend({ type: z.literal("user"), text: z.string() }),
  base.extend({
    type: z.literal("assistant"),
    agent: z.string(),
    model,
    content: z.array(assistantPart),
  }),
  base.extend({
    type: z.literal("compaction"),
    status: z.literal("completed"),
    reason: z.enum(["auto", "manual"]),
    summary: z.string(),
    recent: z.string(),
  }),
  base.extend({
    type: z.literal("compaction"),
    status: z.literal("running"),
    reason: z.enum(["auto", "manual"]),
    summary: z.string(),
    recent: z.string(),
  }),
  base.extend({
    type: z.literal("compaction"),
    status: z.literal("failed"),
    reason: z.enum(["auto", "manual"]),
    error,
  }),
]);
const otherMessage = z.discriminatedUnion("type", [
  base.extend({ type: z.literal("agent-switched"), agent: z.string() }),
  base.extend({ type: z.literal("model-switched"), model }),
  base.extend({
    type: z.literal("location-switched"),
    location: z.object({ directory: z.string() }),
  }),
  base.extend({ type: z.literal("synthetic"), text: z.string() }),
  base.extend({ type: z.literal("system"), text: z.string() }),
  base.extend({ type: z.literal("skill"), skill: z.string(), name: z.string(), text: z.string() }),
  base.extend({
    type: z.literal("shell"),
    shellID: z.string(),
    command: z.string(),
    status: z.enum(["running", "exited", "timeout", "killed"]),
  }),
  base.extend({ type: z.literal("idle"), outcome: z.enum(["succeeded", "failed", "interrupted"]) }),
]);

type ContextEntry = Extract<ChiMentionResult, { kind: "context" }>["entries"][number];

export function boundedPinnedContext(result: Extract<ChiMentionResult, { kind: "context" }>) {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1024 * 1024)
    throw new Error("chi-mention-source-too-large");
  return result;
}

export function pinnedContextRange(pin: Pin, cursorValue?: string) {
  const cursor = cursorValue?.split(":");
  if (
    cursor &&
    (cursor.length !== 2 || cursor[0] !== pin.head || !/^(0|[1-9][0-9]*)$/.test(cursor[1]!))
  )
    throw new Error("chi-mention-invalid-cursor");
  const start = cursor ? Number(cursor[1]) : 0;
  if (!Number.isSafeInteger(start) || start > pin.count)
    throw new Error("chi-mention-invalid-cursor");
  return { start, end: Math.min(start + 8, pin.count) };
}

export function pinnedTimelineEntries(bytes: string[], start: number): ContextEntry[] {
  try {
    const entries = bytes.map((value, index) => {
      const entry = decodeEntry(value);
      if (entry.seq !== start + index) throw new Error("invalid sequence");
      const payload = z.object({ native: z.string() }).parse(entry.payload);
      const native = parseNativeJson(payload.native);
      const identity = z
        .object({ id: z.string().min(1), type: z.string().optional() })
        .parse(native);
      if (entry.kind !== "metadata" && entry.kind !== "message")
        throw new Error("unsupported entry kind");
      const supported =
        entry.kind === "message" &&
        ["user", "assistant", "compaction"].includes(identity.type ?? "");
      if (entry.kind === "message" && !supported) otherMessage.parse(native);
      if (entry.kind === "metadata")
        z.object({ id: z.string(), time: z.object({ created }) }).parse(native);
      return { entry, identity, message: supported ? displayMessage.parse(native) : null };
    });
    let count = 0;
    return entries.map(({ entry, identity, message }) => {
      const events = message ? V2Timeline.pinnedMessage(message) : [];
      const items = events.flatMap((event) =>
        event.type === "timeline" ? [AgentTimelineItemPayloadSchema.parse(event.item)] : [],
      );
      count += items.length;
      if (items.length > 256 || count > 512) throw new Error("too many display items");
      return {
        nativeId: identity.id,
        type: entry.kind === "message" ? (identity.type ?? "message") : entry.kind,
        seq: entry.seq,
        timestamp: message ? new Date(message.time.created).toISOString() : undefined,
        items,
      };
    });
  } catch {
    throw new Error("chi-mention-invalid-response");
  }
}
