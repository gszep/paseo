import { z } from "zod";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
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
