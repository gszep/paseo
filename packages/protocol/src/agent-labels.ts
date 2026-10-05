export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";
export const ISOLATION_LABEL_PREFIX = "paseo.isolation.";
export const ISOLATION_WORKTREE_LABEL = `${ISOLATION_LABEL_PREFIX}worktree`;
export const ISOLATION_REASON_LABEL = `${ISOLATION_LABEL_PREFIX}reason`;
export const ISOLATION_SANDBOX_LABEL = `${ISOLATION_LABEL_PREFIX}sandbox`;

/** Values of {@link ISOLATION_SANDBOX_LABEL}; mirrors the agent record, never its authority. */
export type IsolationSandboxLabelValue = "nono" | "opted-out";

/** Values of {@link ISOLATION_WORKTREE_LABEL}, stamped by the daemon on agent-created agents. */
export type IsolationWorktreeLabelValue = "created" | "opted-out" | "not-git";

export function hasCreatedIsolationWorktree(
  labels: Record<string, unknown> | null | undefined,
): boolean {
  return labels?.[ISOLATION_WORKTREE_LABEL] === "created";
}

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}
