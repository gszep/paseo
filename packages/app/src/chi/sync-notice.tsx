import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import { isTerminalSyncError } from "./sync-destination";
import {
  SyncNoticeView,
  SyncWarningView,
  WorkspaceSyncNoticeView,
  WorkspaceSyncWarningView,
  useSyncNoticeDismissal,
} from "./sync-notice-view";
import {
  deriveSyncNoticeScope,
  parseChiAssociation,
  type SyncNoticeAgent,
} from "./sync-notice-scope";
import { useSyncDestination } from "./use-sync-destination";

export { syncNoticeReason, syncWarningReason, OMITTED_CONTENT_WARNING } from "./sync-notice-view";

/**
 * A single dismissible sync notice, mounted outside the chat feed. It shows the
 * focused conversation's own association status when that session is at fault;
 * otherwise the workspace aggregate is shown as a workspace-scoped notice that
 * names the affected session(s), never dressed up as "this session".
 */
export function WorkspaceSyncNotice({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const state = useSyncDestination(serverId, workspaceId);
  const agents = useSessionStore((store) => store.sessions[serverId]?.agents);
  const focusedAgentId = useSessionStore(
    (store) => store.sessions[serverId]?.focusedAgentId ?? null,
  );
  const workspaceAgents = useMemo<SyncNoticeAgent[]>(() => {
    if (!agents) return [];
    const list: SyncNoticeAgent[] = [];
    for (const agent of agents.values()) {
      if (agent.workspaceId !== workspaceId) continue;
      list.push({
        id: agent.id,
        title: agent.title,
        association: parseChiAssociation(agent.labels["chi.native"]),
      });
    }
    return list;
  }, [agents, workspaceId]);
  const scope = useMemo(
    () =>
      deriveSyncNoticeScope({
        agents: workspaceAgents,
        focusedAgentId,
        workspaceError: state.error,
        workspaceWarning: state.warning,
      }),
    [workspaceAgents, focusedAgentId, state.error, state.warning],
  );

  const subject = scope?.subjectKey ?? "";
  const errorDismissal = useSyncNoticeDismissal(scope?.error ?? null, subject);
  const warningDismissal = useSyncNoticeDismissal(scope?.warning ?? null, subject);

  if (scope?.error && errorDismissal.visible) {
    const terminal = isTerminalSyncError(scope.error);
    if (scope.kind === "workspace") {
      return (
        <WorkspaceSyncNoticeView
          error={scope.error}
          affected={scope.affected}
          terminal={terminal}
          onDismiss={errorDismissal.dismiss}
          onRetry={state.retry}
        />
      );
    }
    return (
      <SyncNoticeView
        error={scope.error}
        terminal={terminal}
        onDismiss={errorDismissal.dismiss}
        onRetry={state.retry}
      />
    );
  }

  if (!scope?.error && scope?.warning && warningDismissal.visible) {
    if (scope.kind === "workspace") {
      return (
        <WorkspaceSyncWarningView
          warning={scope.warning}
          affected={scope.affected}
          onDismiss={warningDismissal.dismiss}
        />
      );
    }
    return <SyncWarningView warning={scope.warning} onDismiss={warningDismissal.dismiss} />;
  }

  return null;
}
