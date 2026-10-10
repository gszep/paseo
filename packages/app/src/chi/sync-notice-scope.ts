/**
 * Scopes the workspace sync notice to the conversation the user is viewing.
 *
 * The daemon's `chiSyncStatus` answers for a whole workspace and reports one
 * aggregated error, which may belong to a sibling session. The per-session
 * truth already exists on each agent's `chi.native` association label, so the
 * notice uses the focused conversation's own status when it has one, and only
 * falls back to a workspace-scoped notice (naming the affected sessions) when
 * the failing conversation is not the one on screen.
 */
import { z } from "zod";

const associationSchema = z.object({
  error: z.string().nullable().optional(),
  warning: z.string().nullable().optional(),
  sourceId: z.string().nullable().optional(),
  head: z.string().nullable().optional(),
});

export interface ChiAssociationStatus {
  error: string | null;
  warning: string | null;
  sourceId: string | null;
  head: string | null;
}

/** Parses an agent's `chi.native` label; malformed labels are treated as absent. */
export function parseChiAssociation(label: string | null | undefined): ChiAssociationStatus | null {
  if (!label) return null;
  try {
    const parsed = associationSchema.safeParse(JSON.parse(label));
    if (!parsed.success) return null;
    return {
      error: parsed.data.error ?? null,
      warning: parsed.data.warning ?? null,
      sourceId: parsed.data.sourceId ?? null,
      head: parsed.data.head ?? null,
    };
  } catch {
    return null;
  }
}

export interface SyncNoticeAgent {
  id: string;
  title: string | null;
  association: ChiAssociationStatus | null;
}

export type SyncNoticeScope =
  | {
      kind: "session";
      agentId: string;
      title: string | null;
      error: string | null;
      warning: string | null;
      subjectKey: string;
    }
  | {
      kind: "workspace";
      error: string | null;
      warning: string | null;
      affected: ReadonlyArray<{ id: string; title: string | null }>;
      subjectKey: string;
    };

/**
 * A dismissible subject key that changes with the actual session, its exact
 * capture checkpoint and the error, so dismissing one conversation's notice
 * never silences another's.
 */
function sessionSubjectKey(agent: SyncNoticeAgent, status: ChiAssociationStatus): string {
  const checkpoint = `${status.sourceId ?? ""}:${status.head ?? ""}`;
  return `session:${agent.id}:${checkpoint}`;
}

export function deriveSyncNoticeScope(input: {
  agents: readonly SyncNoticeAgent[];
  focusedAgentId: string | null;
  workspaceError: string | null;
  workspaceWarning: string | null;
}): SyncNoticeScope | null {
  const focused = input.focusedAgentId
    ? (input.agents.find((agent) => agent.id === input.focusedAgentId) ?? null)
    : null;
  const focusedStatus = focused?.association ?? null;

  // The focused conversation's own error wins; an error anywhere always hides a
  // warning, so a session warning never masks a workspace-level failure.
  if (focused && focusedStatus?.error) {
    return {
      kind: "session",
      agentId: focused.id,
      title: focused.title,
      error: focusedStatus.error,
      warning: null,
      subjectKey: sessionSubjectKey(focused, focusedStatus),
    };
  }
  if (input.workspaceError) {
    return workspaceScope(input.agents, "error", input.workspaceError);
  }
  if (focused && focusedStatus?.warning) {
    return {
      kind: "session",
      agentId: focused.id,
      title: focused.title,
      error: null,
      warning: focusedStatus.warning,
      subjectKey: sessionSubjectKey(focused, focusedStatus),
    };
  }
  if (input.workspaceWarning) {
    return workspaceScope(input.agents, "warning", input.workspaceWarning);
  }
  return null;
}

function workspaceScope(
  agents: readonly SyncNoticeAgent[],
  kind: "error" | "warning",
  code: string,
): SyncNoticeScope {
  const affected = agents
    .filter((agent) => {
      const status = agent.association;
      return kind === "error" ? status?.error === code : status?.warning === code;
    })
    .map((agent) => ({ id: agent.id, title: agent.title }));
  const affectedKey = affected
    .map((agent) => agent.id)
    .sort()
    .join(",");
  return {
    kind: "workspace",
    error: kind === "error" ? code : null,
    warning: kind === "warning" ? code : null,
    affected,
    subjectKey: `workspace:${code}:${affectedKey}`,
  };
}
