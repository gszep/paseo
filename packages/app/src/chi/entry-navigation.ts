import { z } from "zod";
import type {
  ChiHandoff,
  ChiMentionContext,
  ChiMentionResult,
} from "@getpaseo/protocol/chi-mentions";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";

import { useEntryTarget, type EntryTarget } from "./entry-target";
const associationSchema = z.object({ sourceId: z.string().nullable(), repo: z.string() });

function matchesSource(label: string | undefined, sourceId: string, repo: string) {
  if (!label) return false;
  try {
    const value = associationSchema.parse(JSON.parse(label));
    return value.sourceId === sourceId && value.repo === repo;
  } catch {
    return false;
  }
}

export async function findSourceAgent(host: string, sourceId: string, repo: string) {
  const runtime = getHostRuntimeStore().getSnapshot(host);
  if (runtime?.connectionStatus !== "online" || !runtime.client) return null;
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await runtime.client.fetchAgents({
      filter: { includeArchived: true },
      page: { limit: 200, cursor },
    });
    const found = page.entries.find(({ agent }) =>
      matchesSource(agent.labels["chi.native"], sourceId, repo),
    );
    if (found) return found.agent;
    if (!page.pageInfo.hasMore) return null;
    const next = page.pageInfo.nextCursor;
    if (!next || seen.has(next)) throw new Error("chi-invalid-response");
    seen.add(next);
    cursor = next;
  } while (cursor);
  return null;
}

export async function locateMention(
  handoff: ChiHandoff,
  source: Extract<ChiMentionResult, { kind: "source" }>,
  identity: ChiMentionContext,
): Promise<EntryTarget | null> {
  if (!source.origin || source.source.kind !== "neutral") return null;
  const runtime = getHostRuntimeStore();
  const host = source.origin.hostId;
  const snapshot = runtime.getSnapshot(host);
  if (snapshot?.connectionStatus !== "online" || !snapshot.client) return null;
  const client = snapshot.client;
  if (!client.getLastServerInfoMessage()?.features?.chiAppendV3) return null;
  const scope = await client.chiMentions({ operation: { action: "scope" } });
  if (scope.context.actor !== identity.actor || scope.context.deployment !== identity.deployment)
    return null;
  // Reacquire the handoff on this transport before opening a paired host's session.
  await client.chiMentions({
    operation: { action: "read", id: handoff.id, repo: handoff.repo },
    expectedContext: scope.context,
  });
  const agent = await findSourceAgent(host, source.source.id, handoff.repo);
  if (!agent?.workspaceId) return null;
  const index = await client.listAgentTimelinePrompts(agent.id);
  const prompt = index.prompts.find((p) => p.messageId === source.source.entryId);
  if (!prompt) return null;
  return {
    host,
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    entryId: source.source.entryId,
    epoch: index.epoch,
    seq: prompt.seq,
  };
}

export async function openMentionTarget(target: EntryTarget, isCurrent: () => boolean) {
  if (!isCurrent()) return;
  await getHostRuntimeStore().fetchAgentTimeline(
    target.host,
    target.agentId,
    planTimelinePromptJump({ epoch: target.epoch, seq: target.seq }),
  );
  if (!isCurrent()) return;
  useEntryTarget.setState({ target });
  navigateToAgent({
    serverId: target.host,
    agentId: target.agentId,
    workspaceId: target.workspaceId,
  });
}
