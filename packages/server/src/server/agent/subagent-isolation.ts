import { randomBytes } from "node:crypto";
import { z } from "zod";

// The durable record of an agent-created agent's isolation (docs/subagent-isolation.md).
// Admission lives in create-agent/isolation.ts; this record is what resume,
// reload and restart enforce. Labels only mirror it.

export const AgentIsolationSchema = z
  .object({
    worktree: z.enum(["created", "opted-out", "not-git"]),
    sandbox: z.enum(["nono", "opted-out"]),
    reason: z.string().optional(),
    decidedBy: z.string(),
  })
  .strict();

export type AgentIsolation = z.infer<typeof AgentIsolationSchema>;

export function isSandboxed(isolation: AgentIsolation | undefined): boolean {
  return isolation?.sandbox === "nono";
}

/** Each sandboxed subagent owns `refs/heads/paseo-subagents/<slug>/`; nono grants only that. */
export function subagentBranchName(slug: string): string {
  return `paseo-subagents/${slug}/work`;
}

export function newSubagentBranch(): { slug: string; name: string } {
  const slug = `subagent-${randomBytes(4).toString("hex")}`;
  return { slug, name: subagentBranchName(slug) };
}

// Daemon-side tools execute outside the child's sandbox. A sandboxed agent keeps
// only tools that neither run host commands nor act on other agents. This is an
// allowlist so that newly added tools stay unavailable until reviewed.
export const SANDBOXED_AGENT_PASEO_TOOLS: ReadonlySet<string> = new Set([
  "create_agent",
  "list_providers",
  "list_models",
  "list_profiles",
  "inspect_provider",
  "human_prompts",
  "speak",
]);
