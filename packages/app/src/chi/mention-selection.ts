import type { ChiParticipant } from "@getpaseo/protocol/chi-mentions";
import type { ChiMentionContext } from "@getpaseo/protocol/chi-mentions";

export type SelectedMention = ChiParticipant & { context: ChiMentionContext };
const selected = new Map<string, SelectedMention[]>();
const listeners = new Set<() => void>();
const empty: SelectedMention[] = [];
function key(serverId: string, agentId: string) {
  return JSON.stringify([serverId, agentId]);
}
export function selectMention(serverId: string, agentId: string, participant: SelectedMention) {
  const scope = key(serverId, agentId);
  const previous = selected.get(scope) ?? empty;
  selected.set(scope, [...previous.filter((p) => p.ownerId !== participant.ownerId), participant]);
  for (const listener of listeners) listener();
}
export function clearHostMentionSelection(serverId: string) {
  for (const scope of selected.keys()) if (JSON.parse(scope)[0] === serverId) selected.delete(scope);
  for (const listener of listeners) listener();
}
export function selectedMentionContext(serverId: string, agentId: string) {
  return mentionSelection(serverId, agentId)[0]?.context;
}
export function clearMentionSelection(serverId: string, agentId: string) {
  selected.delete(key(serverId, agentId));
  for (const listener of listeners) listener();
}
export function mentionSelection(serverId: string, agentId: string) {
  return selected.get(key(serverId, agentId)) ?? empty;
}
export function subscribeMentionSelection(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function selectedRecipients(serverId: string, agentId: string, text: string) {
  return mentionSelection(serverId, agentId)
    .filter((p) => {
      const handle = p.handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[\\s(])@${handle}(?=$|[\\s),.!?:;])`, "i").test(text);
    })
    .map((p) => p.ownerId);
}
