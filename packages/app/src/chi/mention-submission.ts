import AsyncStorage from "@react-native-async-storage/async-storage";
import { SendAgentMessageRequestSchema } from "@getpaseo/protocol/messages";
import type { ComposerSendClient } from "@/composer/actions";

const savedSchema = SendAgentMessageRequestSchema.omit({ type: true, requestId: true });
export type MentionSubmission = ReturnType<typeof savedSchema.parse>;
function key(host: string, agent: string) { return `chi-mention-send:${JSON.stringify([host, agent])}`; }
export async function readMentionSubmission(host: string, agent: string) {
  const stored = await AsyncStorage.getItem(key(host, agent));
  if (!stored) return null;
  const pending = savedSchema.parse(JSON.parse(stored));
  if (pending.agentId !== agent || !pending.messageId || !pending.chiMentions?.length || !pending.chiMentionContext) throw new Error("chi-mention-submission-corrupt");
  return pending;
}
/** Queue retries carry the same message ID. Draft text is never a retry identity. */
export async function prepareMentionSubmission(host: string, request: MentionSubmission) {
  const pending = await readMentionSubmission(host, request.agentId);
  if (pending) {
    if (JSON.stringify(pending) === JSON.stringify(savedSchema.parse(request))) return;
    throw new Error("chi-mention-submission-unresolved");
  }
  if (!request.chiMentions?.length) return;
  await AsyncStorage.setItem(key(host, request.agentId), JSON.stringify(savedSchema.parse(request)));
}
export async function completeMentionSubmission(host: string, agent: string) {
  await AsyncStorage.removeItem(key(host, agent)).catch(() => undefined);
}
export async function retryMentionSubmission(host: string, agent: string, client: ComposerSendClient) {
  const pending = await readMentionSubmission(host, agent);
  if (!pending?.messageId) throw new Error("chi-mention-submission-missing");
  await client.sendAgentMessage(agent, pending.text, { messageId: pending.messageId, chiMentions: pending.chiMentions, chiMentionContext: pending.chiMentionContext, activeTurnBehavior: pending.activeTurnBehavior, images: pending.images ?? [], attachments: pending.attachments ?? [] });
  await completeMentionSubmission(host, agent);
}
