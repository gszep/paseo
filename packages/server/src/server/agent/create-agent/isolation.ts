import type { Logger } from "pino";
import {
  ISOLATION_LABEL_PREFIX,
  ISOLATION_REASON_LABEL,
  ISOLATION_SANDBOX_LABEL,
  ISOLATION_WORKTREE_LABEL,
  type IsolationSandboxLabelValue,
  type IsolationWorktreeLabelValue,
} from "@getpaseo/protocol/agent-labels";
import type { CreateAgentIsolation } from "@getpaseo/protocol/messages";

import { runGitCommand } from "../../../utils/run-git-command.js";
import { isSandboxed, type AgentIsolation } from "../subagent-isolation.js";

export const MAX_ISOLATION_REASON_LENGTH = 200;

/**
 * Worktree placement for an agent created by another agent.
 *
 * - `worktree`: create a fresh worktree workspace branched from `baseRef`.
 * - `requested`: the caller explicitly asked for a new worktree, which already isolates it.
 * - `opted-out`: the caller shares the source checkout and gave a reason.
 * - `not-git`: the source is not in a git repository, so the agent shares it.
 */
export type SubagentWorktreeDecision =
  | { kind: "worktree"; sourceCwd: string; baseRef: string }
  | { kind: "requested"; sourceCwd: string }
  | { kind: "opted-out"; sourceCwd: string; reason: string }
  | { kind: "not-git"; sourceCwd: string };

/** Whether an agent-created agent runs inside the nono sandbox. */
export type SubagentSandboxDecision = { kind: "nono" } | { kind: "opted-out"; reason: string };

export interface SubagentIsolationSummary {
  worktree: IsolationWorktreeLabelValue;
  sandbox: IsolationSandboxLabelValue;
  reason?: string;
  note?: string;
}

export class SubagentIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentIsolationError";
  }
}

const OPT_OUT_HINT =
  "Pass isolation { worktree: false, reason } to share the source checkout instead.";

export type NormalizedIsolationRequest =
  | { worktree: true; sandbox: true }
  | { worktree: boolean; sandbox: boolean; reason: string };

export function normalizeIsolationRequest(
  request: CreateAgentIsolation | undefined,
): NormalizedIsolationRequest {
  const worktree = request?.worktree ?? true;
  const sandbox = request?.sandbox ?? true;
  if (worktree && sandbox) {
    if (request?.reason !== undefined) {
      throw new SubagentIsolationError(
        "isolation.reason is only accepted together with worktree: false or sandbox: false",
      );
    }
    return { worktree: true, sandbox: true };
  }
  const reason = request?.reason?.trim() ?? "";
  if (!reason) {
    throw new SubagentIsolationError(
      worktree
        ? "isolation.sandbox false requires a non-empty reason explaining why the subagent runs without the sandbox"
        : "isolation.worktree false requires a non-empty reason explaining why the subagent shares the checkout",
    );
  }
  if (reason.length > MAX_ISOLATION_REASON_LENGTH) {
    throw new SubagentIsolationError(
      `isolation.reason must be ${MAX_ISOLATION_REASON_LENGTH} characters or fewer`,
    );
  }
  // eslint-disable-next-line no-control-regex -- the reason is a single-line audit record.
  if (/[\u0000-\u001f\u007f]/.test(reason)) {
    throw new SubagentIsolationError("isolation.reason must be a single line of plain text");
  }
  return { worktree, sandbox, reason };
}

/**
 * Decide whether an agent-created agent runs under nono. A sandboxed caller's
 * checkout is untrusted outside the sandbox, so its subagents share it and stay
 * sandboxed: creating a worktree from it would run git (and its hooks) unconfined.
 */
export function resolveSubagentSandboxDecision(input: {
  request: CreateAgentIsolation | undefined;
  callerIsolation: AgentIsolation | undefined;
  worktree: SubagentWorktreeDecision;
}): SubagentSandboxDecision {
  const request = normalizeIsolationRequest(input.request);
  if (isSandboxed(input.callerIsolation)) {
    if (!request.sandbox) {
      throw new SubagentIsolationError("A sandboxed agent cannot create an unsandboxed agent");
    }
    if (input.worktree.kind === "worktree" || input.worktree.kind === "requested") {
      throw new SubagentIsolationError(
        "A sandboxed agent's subagents share its worktree; pass isolation { worktree: false, reason }",
      );
    }
  }
  if (request.sandbox) return { kind: "nono" };
  return { kind: "opted-out", reason: request.reason };
}

/** The durable record resume, reload and restart enforce. */
export function isolationRecord(input: {
  worktree: SubagentWorktreeDecision;
  sandbox: SubagentSandboxDecision;
  callerAgentId: string;
}): AgentIsolation {
  const reason = optOutReason(input.worktree, input.sandbox);
  return {
    worktree: summarizeWorktree(input.worktree),
    sandbox: input.sandbox.kind,
    ...(reason ? { reason } : {}),
    decidedBy: input.callerAgentId,
  };
}

// One reason covers every opt-out in a request.
function optOutReason(
  worktree: SubagentWorktreeDecision,
  sandbox: SubagentSandboxDecision,
): string | undefined {
  if (worktree.kind === "opted-out") return worktree.reason;
  if (sandbox.kind === "opted-out") return sandbox.reason;
  return undefined;
}

function summarizeWorktree(decision: SubagentWorktreeDecision): IsolationWorktreeLabelValue {
  switch (decision.kind) {
    case "worktree":
    case "requested":
      return "created";
    case "opted-out":
      return "opted-out";
    case "not-git":
      return "not-git";
  }
}

/**
 * Decide where an agent-created agent runs. Call only for agent callers; agents
 * created by humans keep their requested placement.
 */
export async function resolveSubagentWorktreeDecision(input: {
  request: CreateAgentIsolation | undefined;
  sourceCwd: string;
  explicitWorktree: boolean;
}): Promise<SubagentWorktreeDecision> {
  const request = normalizeIsolationRequest(input.request);
  if (input.explicitWorktree) {
    if (!request.worktree) {
      throw new SubagentIsolationError(
        "isolation.worktree false cannot be combined with an explicit new worktree",
      );
    }
    return { kind: "requested", sourceCwd: input.sourceCwd };
  }
  if (!request.worktree) {
    return { kind: "opted-out", sourceCwd: input.sourceCwd, reason: request.reason };
  }
  const baseRef = await resolveSourceBaseRef(input.sourceCwd);
  if (baseRef === null) {
    return { kind: "not-git", sourceCwd: input.sourceCwd };
  }
  return { kind: "worktree", sourceCwd: input.sourceCwd, baseRef };
}

/**
 * The ref a subagent worktree branches from: the source checkout's current
 * branch, or its commit when HEAD is detached. Null outside a git work tree.
 */
async function resolveSourceBaseRef(cwd: string): Promise<string | null> {
  const topLevel = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd,
    acceptExitCodes: [0, 128],
  });
  if (topLevel.exitCode !== 0) {
    if (/not a git repository/i.test(topLevel.stderr)) {
      return null;
    }
    throw new SubagentIsolationError(
      `Cannot inspect ${cwd} for subagent worktree isolation: ${topLevel.stderr.trim()}. ${OPT_OUT_HINT}`,
    );
  }
  const head = await runGitCommand(["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  if (head.exitCode !== 0 || !head.stdout.trim()) {
    throw new SubagentIsolationError(
      `Cannot branch a subagent worktree from ${cwd}: HEAD has no commit. ${OPT_OUT_HINT}`,
    );
  }
  const branch = await runGitCommand(["symbolic-ref", "--quiet", "HEAD"], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  return branch.exitCode === 0 && branch.stdout.trim() ? branch.stdout.trim() : head.stdout.trim();
}

export function wrapSubagentWorktreeCreationError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new SubagentIsolationError(
    `Could not create the subagent's worktree: ${message}. ${OPT_OUT_HINT}`,
  );
}

export function isolationLabels(isolation: AgentIsolation): Record<string, string> {
  return {
    [ISOLATION_WORKTREE_LABEL]: isolation.worktree,
    [ISOLATION_SANDBOX_LABEL]: isolation.sandbox,
    ...(isolation.reason ? { [ISOLATION_REASON_LABEL]: isolation.reason } : {}),
  };
}

/** Caller labels cannot claim or rewrite the daemon's isolation record. */
export function withIsolationLabels(
  labels: Record<string, string> | undefined,
  isolation: AgentIsolation,
): Record<string, string> {
  const callerLabels = Object.fromEntries(
    Object.entries(labels ?? {}).filter(([key]) => !key.startsWith(ISOLATION_LABEL_PREFIX)),
  );
  return { ...callerLabels, ...isolationLabels(isolation) };
}

export function summarizeIsolation(
  decision: SubagentWorktreeDecision,
  sandbox: SubagentSandboxDecision,
): SubagentIsolationSummary {
  const reason = optOutReason(decision, sandbox);
  return {
    worktree: summarizeWorktree(decision),
    sandbox: sandbox.kind,
    ...(reason ? { reason } : {}),
    ...(decision.kind === "not-git"
      ? {
          note: `${decision.sourceCwd} is not inside a git repository, so the subagent shares that directory.`,
        }
      : {}),
  };
}

export function logSubagentIsolation(input: {
  logger: Logger;
  decision: SubagentWorktreeDecision;
  sandbox: SubagentSandboxDecision;
  callerAgentId: string;
  agentId: string;
  workspaceId: string | undefined;
  cwd: string;
}): void {
  const { decision } = input;
  input.logger.info(
    {
      event: "subagent_isolation",
      callerAgentId: input.callerAgentId,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      sourceCwd: decision.sourceCwd,
      ...summarizeIsolation(decision, input.sandbox),
      ...(decision.kind === "worktree" ? { baseRef: decision.baseRef } : {}),
    },
    describeIsolationLog(decision, input.sandbox),
  );
}

function describeIsolationLog(
  decision: SubagentWorktreeDecision,
  sandbox: SubagentSandboxDecision,
): string {
  if (sandbox.kind === "opted-out") return "Subagent runs without the nono sandbox (opted out)";
  if (decision.kind === "opted-out") {
    return "Subagent shares the source checkout (worktree isolation opted out)";
  }
  return "Subagent isolation decided";
}
