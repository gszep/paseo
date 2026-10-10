import type { ChiEntryRef, ChiHandoff, ChiMentionResult } from "@getpaseo/protocol/chi-mentions";
import { hydrateStreamState, type StreamItem } from "@/types/stream";

export type ConversationPage = Extract<ChiMentionResult, { kind: "context" }>;

export function conversationReference(handoff: ChiHandoff, index: number): ChiEntryRef {
  const source = handoff.sources[index];
  const ref = source?.kind === "neutral" ? source.appendRef : undefined;
  if (!ref || ref.pin.repo !== handoff.repo || ref.seq >= ref.pin.count)
    throw new Error("chi-mention-native-source-required");
  return ref;
}

export function conversationKey(ref: ChiEntryRef) {
  return JSON.stringify([
    ref.pin.deployment,
    ref.pin.repo,
    ref.pin.sourceId,
    ref.pin.count,
    ref.pin.head,
    ref.seq,
  ]);
}

export function mentionWindowCursor(ref: ChiEntryRef) {
  return `${ref.pin.head}:${Math.max(0, ref.seq - 3)}`;
}

export function validateConversationPage(
  ref: ChiEntryRef,
  page: ConversationPage,
  cursor: string,
): ConversationPage {
  const received = page.source.kind === "neutral" ? page.source.appendRef : undefined;
  if (!received || conversationKey(received) !== conversationKey(ref))
    throw new Error("chi-mention-invalid-response");
  const start = Number(cursor.slice(cursor.lastIndexOf(":") + 1));
  if (
    !cursor.startsWith(`${ref.pin.head}:`) ||
    !Number.isSafeInteger(start) ||
    start < 0 ||
    start >= ref.pin.count
  )
    throw new Error("chi-mention-invalid-response");
  if (page.entries.length !== Math.min(8, ref.pin.count - start))
    throw new Error("chi-mention-invalid-response");
  for (const [index, entry] of page.entries.entries()) {
    validateConversationEntry(entry, start + index, ref.pin.count);
  }
  const end = start + page.entries.length;
  const expectedNext = end < ref.pin.count ? `${ref.pin.head}:${end}` : null;
  if (page.nextCursor !== expectedNext) throw new Error("chi-mention-invalid-response");
  return page;
}

function validateConversationEntry(
  entry: ConversationPage["entries"][number],
  seq: number,
  count: number,
) {
  if (entry.seq !== seq || entry.seq >= count || !entry.items)
    throw new Error("chi-mention-invalid-response");
  if (entry.items.length && (!entry.timestamp || !Number.isFinite(Date.parse(entry.timestamp))))
    throw new Error("chi-mention-invalid-response");
  for (const item of entry.items) {
    if (
      (item.type === "user_message" || item.type === "assistant_message") &&
      item.messageId !== entry.nativeId
    )
      throw new Error("chi-mention-invalid-response");
  }
}

export function olderConversationCursor(ref: ChiEntryRef, page: ConversationPage) {
  const start = page.entries[0]?.seq;
  return start === undefined || start === 0
    ? undefined
    : `${ref.pin.head}:${Math.max(0, start - 8)}`;
}

export function conversationPresentation(
  ref: ChiEntryRef,
  pages: readonly ConversationPage[],
  scopeKey: string,
) {
  const entries = new Map<number, ConversationPage["entries"][number]>();
  for (const page of pages)
    for (const entry of page.entries) {
      if (entry.seq !== undefined && !entries.has(entry.seq)) entries.set(entry.seq, entry);
    }
  const items: StreamItem[] = [];
  let targetItemId: string | undefined;
  let targetNativeId: string | undefined;
  const namespace = encodeURIComponent(JSON.stringify([scopeKey, conversationKey(ref)]));
  for (const [seq, entry] of [...entries].sort(([a], [b]) => a - b)) {
    if (!entry.items?.length || !entry.timestamp) continue;
    const timestamp = new Date(entry.timestamp);
    const rows = hydrateStreamState(
      entry.items.map((item) => ({
        event: { type: "timeline" as const, provider: "opencode" as const, item },
        timestamp,
      })),
      { source: "canonical" },
    );
    for (const [index, row] of rows.entries()) {
      const id = `chi:${namespace}:${seq}:${index}`;
      items.push({ ...row, id });
      if (seq === ref.seq && index === 0) {
        targetItemId = id;
        targetNativeId = entry.nativeId;
      }
    }
  }
  return { items, targetItemId, targetNativeId };
}
