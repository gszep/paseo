import { SendAgentMessageRequestSchema } from "@getpaseo/protocol/messages";
import type { ComposerSendClient } from "@/composer/actions";
import type { ContinuationStorage } from "./continuation-state";
import type { ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { sameMentionContext } from "./mention-context";

const savedSchema = SendAgentMessageRequestSchema.omit({ type: true, requestId: true });
export type MentionSubmission = ReturnType<typeof savedSchema.parse>;
function key(host: string, agent: string) {
  return `chi-mention-send:${JSON.stringify([host, agent])}`;
}

/** Draft text never identifies a retry. Only the saved immutable wire request does. */
export function createMentionSubmissions(storage: ContinuationStorage) {
  const lanes = new Map<string, Promise<unknown>>();
  async function exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    const task = (lanes.get(id) ?? Promise.resolve()).catch(() => undefined).then(run);
    lanes.set(id, task);
    try {
      return await task;
    } finally {
      if (lanes.get(id) === task) lanes.delete(id);
    }
  }
  async function read(host: string, agent: string) {
    const stored = await storage.getItem(key(host, agent));
    if (!stored) return null;
    const pending = savedSchema.parse(JSON.parse(stored));
    if (
      pending.agentId !== agent ||
      !pending.messageId ||
      !pending.chiMentions?.length ||
      !pending.chiMentionContext
    )
      throw new Error("chi-mention-submission-corrupt");
    return pending;
  }
  async function prepare(host: string, request: MentionSubmission) {
    // Copy before awaiting: callers cannot mutate the saved wire payload in flight.
    const immutable = savedSchema.parse(request);
    return exclusive(key(host, immutable.agentId), async () => {
      const pending = await read(host, immutable.agentId);
      if (pending) {
        if (JSON.stringify(pending) === JSON.stringify(immutable)) return;
        throw new Error("chi-mention-submission-unresolved");
      }
      if (!immutable.chiMentions?.length) return;
      if (!immutable.messageId || !immutable.chiMentionContext)
        throw new Error("chi-mention-context-required");
      await storage.setItem(key(host, immutable.agentId), JSON.stringify(immutable));
    });
  }
  async function complete(host: string, agent: string, messageId: string) {
    await exclusive(key(host, agent), async () => {
      // A late response from a concurrent retry cannot erase a newer saved send.
      if ((await read(host, agent))?.messageId === messageId)
        await storage.removeItem(key(host, agent));
    }).catch(() => undefined);
  }
  async function retry(
    host: string,
    agent: string,
    context: ChiMentionContext,
    client: ComposerSendClient,
  ) {
    const pending = await read(host, agent);
    if (!pending?.messageId) throw new Error("chi-mention-submission-missing");
    if (!pending.chiMentionContext || !sameMentionContext(context, pending.chiMentionContext))
      throw new Error("chi-mention-context-changed");
    await client.sendAgentMessage(agent, pending.text, {
      messageId: pending.messageId,
      chiMentions: pending.chiMentions,
      chiMentionContext: pending.chiMentionContext,
      activeTurnBehavior: pending.activeTurnBehavior,
      images: pending.images ?? [],
      attachments: pending.attachments ?? [],
    });
    await complete(host, agent, pending.messageId);
  }
  return { read, prepare, complete, retry };
}
