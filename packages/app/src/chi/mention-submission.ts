import { SendAgentMessageRequestSchema } from "@getpaseo/protocol/messages";
import type { ComposerSendClient } from "@/composer/actions";
import type { ContinuationStorage } from "./continuation-state";
import type { ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { sameMentionContext } from "./mention-context";
import { ChiOperationError } from "@getpaseo/protocol/chi-mentions";
import { withOperationStorage } from "./operation-storage";
import { z } from "zod";

const savedSchema = SendAgentMessageRequestSchema.omit({ type: true, requestId: true });
const entrySchema = savedSchema.extend({ attempt: z.string().uuid().optional() });
export type MentionSubmission = ReturnType<typeof savedSchema.parse>;
function key(host: string, agent: string) {
  return `chi-mention-send:${JSON.stringify([host, agent])}`;
}

/** Draft text never identifies a retry. Only the saved immutable wire request does. */
export function createMentionSubmissions(storage: ContinuationStorage) {
  const exclusive = <T>(id: string, run: () => Promise<T>) =>
    withOperationStorage(storage, id, run);
  async function readEntry(host: string, agent: string) {
    const stored = await storage.getItem(key(host, agent));
    if (!stored) return null;
    const { attempt, ...pending } = entrySchema.parse(JSON.parse(stored));
    if (
      pending.agentId !== agent ||
      !pending.messageId ||
      !pending.chiMentions?.length ||
      !pending.chiMentionContext
    )
      throw new Error("chi-mention-submission-corrupt");
    return { request: pending, attempt };
  }
  async function read(host: string, agent: string) {
    return (await readEntry(host, agent))?.request ?? null;
  }
  async function prepare(host: string, request: MentionSubmission) {
    // Copy before awaiting: callers cannot mutate the saved wire payload in flight.
    const immutable = savedSchema.parse(request);
    if (immutable.chiMentions?.length && immutable.text.length > 8000)
      throw new Error("chi-mention-text-too-long");
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
  async function beginAttempt(host: string, request: MentionSubmission) {
    const immutable = savedSchema.parse(request);
    const agent = immutable.agentId;
    return exclusive(key(host, agent), async () => {
      const saved = await readEntry(host, agent);
      if (!saved || JSON.stringify(saved.request) !== JSON.stringify(immutable))
        throw new Error("chi-mention-submission-unresolved");
      const attempt = crypto.randomUUID();
      await storage.setItem(key(host, agent), JSON.stringify({ ...saved.request, attempt }));
      return attempt;
    });
  }
  async function retry(
    host: string,
    agent: string,
    context: ChiMentionContext,
    client: ComposerSendClient,
  ) {
    const pending = await read(host, agent);
    if (!pending?.messageId) throw new Error("chi-mention-submission-missing");
    const authorization = pending.chiMentionAuthorization ?? pending.chiMentionContext;
    if (!authorization || !sameMentionContext(context, authorization))
      throw new Error("chi-mention-context-changed");
    const attempt = await beginAttempt(host, pending);
    try {
      await client.sendAgentMessage(agent, pending.text, {
        messageId: pending.messageId,
        chiMentions: pending.chiMentions,
        chiMentionContext: pending.chiMentionContext,
        ...(pending.chiMentionAuthorization
          ? { chiMentionAuthorization: pending.chiMentionAuthorization }
          : {}),
        activeTurnBehavior: pending.activeTurnBehavior,
        images: pending.images ?? [],
        attachments: pending.attachments ?? [],
      });
    } catch (error) {
      await reject(host, agent, pending.messageId, error, attempt);
      throw error;
    }
    await complete(host, agent, pending.messageId);
  }
  async function reject(
    host: string,
    agent: string,
    messageId: string,
    error: unknown,
    attempt?: string,
  ) {
    if (
      attempt === undefined ||
      !(error instanceof ChiOperationError) ||
      error.failure?.outcome !== "not_committed"
    )
      return;
    await exclusive(key(host, agent), async () => {
      const saved = await readEntry(host, agent);
      if (saved?.request.messageId === messageId && saved.attempt === attempt)
        await storage.removeItem(key(host, agent));
    }).catch(() => undefined);
  }
  async function reauthorize(host: string, agent: string, context: ChiMentionContext) {
    await exclusive(key(host, agent), async () => {
      const entry = await readEntry(host, agent);
      const saved = entry?.request;
      if (
        !saved?.chiMentionContext ||
        saved.chiMentionContext.actor !== context.actor ||
        saved.chiMentionContext.repo !== context.repo
      )
        throw new Error("chi-mention-context-changed");
      await storage.setItem(
        key(host, agent),
        JSON.stringify({
          ...saved,
          chiMentionAuthorization: context,
          attempt: crypto.randomUUID(),
        }),
      );
    });
  }
  return { read, prepare, complete, retry, reject, reauthorize, beginAttempt };
}
