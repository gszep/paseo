import type { Logger } from "pino";
import type { AgentLaunchContext, AgentSessionConfig } from "../agent-sdk-types.js";
import { ConfinementRefusal, prepareWritePolicy, WriteConfinementRequestSchema } from "./policy.js";

/** Never silently run an opted-in builder through an unconfined provider. */
export async function assertWriteConfinementAvailable(input: {
  config: Pick<AgentSessionConfig, "cwd" | "featureValues">;
  launch?: AgentLaunchContext;
  logger: Logger;
}): Promise<void> {
  const value = input.config.featureValues?.writeConfinement;
  if (value === undefined) return;
  const parsed = WriteConfinementRequestSchema.safeParse(value);
  if (parsed.success && parsed.data.mode === "off") return;
  let policyDigest: string | null = null;
  let worktreeRoot: string | null = null;
  try {
    if (!parsed.success)
      throw new ConfinementRefusal("invalid-root", "invalid per-agent writeConfinement policy");
    const request = parsed.data;
    if (request.mode === "off") return;
    const policy = await prepareWritePolicy({
      worktreeRoot: input.config.cwd,
      mode: request.mode,
      scratchRoots: request.scratchRoots,
    });
    policyDigest = policy.digest;
    worktreeRoot = policy.worktreeRoot;
    throw new ConfinementRefusal(
      "integration-unavailable",
      "confined OpenCode agents are not available: trusted per-tool process attribution, daemon-side terminals/tools, shared-inode isolation, and complete denial collection must pass acceptance first. No agent process was launched.",
    );
  } catch (error) {
    input.logger.warn(
      {
        type: "guardrail",
        scope: "agent-admission",
        agentId: input.launch?.agentId ?? null,
        cwd: input.config.cwd,
        worktreeRoot,
        policyDigest,
        outcome: "launch-refused",
        evidence: "admission",
        coverage: "complete",
        policyViolation: false,
        outsideWorktree: null,
        reason: error instanceof ConfinementRefusal ? error.reason : "policy-unavailable",
      },
      "Write confinement refused agent admission",
    );
    throw error;
  }
}
