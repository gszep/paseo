import { Command, Option } from "commander";
import {
  getStructuredAgentResponse,
  StructuredAgentResponseError,
} from "@getpaseo/server/agent-response";
import type {
  AgentSnapshotPayload,
  CreateAgentIsolation,
  CreateAgentWorktreeTarget,
} from "@getpaseo/protocol/messages";
import { ISOLATION_SANDBOX_LABEL, ISOLATION_WORKTREE_LABEL } from "@getpaseo/protocol/agent-labels";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lookup } from "mime-types";
import { parseDuration } from "../../utils/duration.js";
import { collectMultiple } from "../../utils/command-options.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import { buildWorkspaceSource } from "../workspace/create.js";

export { resolveProviderAndModel } from "../../utils/provider-model.js";

export function addRunOptions(cmd: Command): Command {
  return (
    cmd
      .description("Create and start an agent with a task")
      .argument("<prompt>", "The task/prompt for the agent")
      .option("-d, --background", "Run in background")
      // COMPAT(detachRunFlag): --detach used to mean background execution, not
      // ownership transfer. Added in v0.2.0; remove after 2027-01-17.
      .addOption(new Option("--detach", "Legacy alias for --background").hideHelp())
      .option("--title <title>", "Assign a title to the agent")
      .addOption(new Option("--name <name>", "Hidden alias for --title").hideHelp())
      .option(
        "--provider <provider>",
        "Agent provider, or provider/model (e.g. codex or codex/gpt-5.4)",
      )
      .option(
        "--model <model>",
        "Model to use (e.g., claude-sonnet-4-20250514, claude-3-5-haiku-20241022)",
      )
      .option("--thinking <id>", "Thinking option ID to use for this run")
      .option("--mode <mode>", "Provider-specific mode (e.g., plan, default, bypass)")
      .option("--new-workspace <local|worktree>", "Create a separate local or worktree workspace")
      .addOption(new Option("--worktree <name>", "Legacy workspace isolation alias").hideHelp())
      .option(
        "--worktree-mode <mode>",
        "Worktree mode: branch-off, checkout-branch, or checkout-pr",
      )
      .option("--worktree-slug <slug>", "Managed worktree path slug")
      .option("--new-branch <name>", "New branch name for branch-off mode")
      .option("--base <ref>", "Base ref for branch-off mode")
      .option("--branch <name>", "Existing branch for checkout-branch mode")
      .option("--pr-number <n>", "Pull request or change request number for checkout-pr mode")
      .option("--forge <forge>", "Forge for checkout-pr mode")
      .option(
        "--workspace <id>",
        "Run in an existing workspace (agent-scoped: the checkout the new worktree branches from)",
      )
      .option(
        "--share-checkout <reason>",
        "Agent-scoped runs only: share the source checkout instead of a new worktree (reason is recorded)",
      )
      .option(
        "--unsandboxed <reason>",
        "Agent-scoped runs only: run without the nono sandbox (reason is recorded)",
      )
      .option(
        "--image <path>",
        "Attach image(s) to the initial prompt (can be used multiple times)",
        collectMultiple,
        [],
      )
      .option("--cwd <path>", "Working directory (default: current)")
      .option(
        "--env <key=value>",
        "Set environment variable(s) for the agent process (can be used multiple times)",
        collectMultiple,
        [],
      )
      .option(
        "--label <key=value>",
        "Add label(s) to the agent (can be used multiple times)",
        collectMultiple,
        [],
      )
      .option(
        "--wait-timeout <duration>",
        "Maximum time to wait for agent to finish (e.g., 30s, 5m, 1h). Default: no limit",
      )
      .option(
        "--output-schema <schema>",
        "Output JSON matching the provided schema file path or inline JSON schema",
      )
  );
}

/** Result type for agent run command */
export interface AgentRunResult {
  agentId: string;
  status: "created" | "running" | "completed" | "timeout" | "permission" | "error";
  provider: string;
  cwd: string;
  title: string | null;
}

/** Schema for agent run output */
export const agentRunSchema: OutputSchema<AgentRunResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "PROVIDER", field: "provider", width: 10 },
    { header: "CWD", field: "cwd", width: 30 },
    { header: "TITLE", field: "title", width: 20 },
  ],
};

export interface AgentRunOptions extends CommandOptions {
  background?: boolean;
  detach?: boolean;
  title?: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  mode?: string;
  newWorkspace?: string;
  worktree?: string;
  worktreeMode?: string;
  worktreeSlug?: string;
  newBranch?: string;
  base?: string;
  branch?: string;
  prNumber?: string;
  forge?: string;
  workspace?: string;
  shareCheckout?: string;
  unsandboxed?: string;
  image?: string[];
  cwd?: string;
  env?: string[];
  label?: string[];
  waitTimeout?: string;
  outputSchema?: string;
}

function resolveNewWorkspaceKind(options: AgentRunOptions): string | undefined {
  return options.newWorkspace ?? (options.worktree ? "worktree" : undefined);
}

function buildRunWorkspaceSource(options: AgentRunOptions, cwd: string) {
  const newWorkspace = resolveNewWorkspaceKind(options) ?? "local";
  return buildWorkspaceSource({
    daemonTarget: options.daemonTarget,
    isolation: newWorkspace,
    path: cwd,
    mode: options.worktreeMode,
    worktreeSlug: options.worktreeSlug ?? options.worktree,
    newBranch: options.newBranch,
    base: options.base,
    branch: options.branch,
    prNumber: options.prNumber,
    forge: options.forge,
  });
}

function toRunResult(
  agent: AgentSnapshotPayload,
  statusOverride?: AgentRunResult["status"],
): AgentRunResult {
  return {
    agentId: agent.id,
    status: statusOverride ?? (agent.status === "running" ? "running" : "created"),
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title,
  };
}

function loadOutputSchema(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) {
    const error: CommandError = {
      code: "INVALID_OUTPUT_SCHEMA",
      message: "--output-schema cannot be empty",
      details: "Provide a JSON schema file path or inline JSON object",
    };
    throw error;
  }

  let source = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      source = readFileSync(resolve(trimmed), "utf8");
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const error: CommandError = {
        code: "INVALID_OUTPUT_SCHEMA",
        message: `Failed to read output schema file: ${trimmed}`,
        details: message,
      };
      throw error;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "INVALID_OUTPUT_SCHEMA",
      message: "Failed to parse output schema JSON",
      details: message,
    };
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error: CommandError = {
      code: "INVALID_OUTPUT_SCHEMA",
      message: "Output schema must be a JSON object",
    };
    throw error;
  }

  return parsed as Record<string, unknown>;
}

class StructuredRunStatusError extends Error {
  readonly kind: "timeout" | "permission" | "error" | "empty";

  constructor(kind: "timeout" | "permission" | "error" | "empty", message: string) {
    super(message);
    this.name = "StructuredRunStatusError";
    this.kind = kind;
  }
}

async function fetchStructuredOutput(
  caller: (structuredPrompt: string) => Promise<string>,
  prompt: string,
  outputSchema: ReturnType<typeof loadOutputSchema>,
): Promise<Record<string, unknown>> {
  try {
    return await getStructuredAgentResponse<Record<string, unknown>>({
      caller,
      prompt,
      schema: outputSchema,
      schemaName: "RunOutput",
      maxRetries: 2,
    });
  } catch (err) {
    if (err instanceof StructuredRunStatusError) {
      throw {
        code: "OUTPUT_SCHEMA_FAILED",
        message: err.message,
      } satisfies CommandError;
    }
    if (err instanceof StructuredAgentResponseError) {
      throw {
        code: "OUTPUT_SCHEMA_FAILED",
        message: "Agent response did not match the required output schema",
        details:
          err.validationErrors.length > 0
            ? err.validationErrors.join("\n")
            : err.lastResponse || "No response",
      } satisfies CommandError;
    }
    throw err;
  }
}

type ConnectedDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;

export interface StructuredResponseTimelineClient {
  fetchAgentTimeline: ConnectedDaemonClient["fetchAgentTimeline"];
}

export async function resolveStructuredResponseMessage(options: {
  client: StructuredResponseTimelineClient;
  agentId: string;
  lastMessage: string | null;
}): Promise<string | null> {
  const direct = options.lastMessage?.trim();
  if (direct) {
    return direct;
  }

  try {
    const timeline = await options.client.fetchAgentTimeline(options.agentId, {
      direction: "tail",
      limit: 200,
    });
    for (let index = timeline.entries.length - 1; index >= 0; index -= 1) {
      const entry = timeline.entries[index];
      if (!entry || entry.item.type !== "assistant_message") {
        continue;
      }
      const text = entry.item.text.trim();
      if (text.length > 0) {
        return text;
      }
    }
  } catch {
    // Leave empty; caller will surface a consistent structured-output failure message.
  }

  return null;
}

function structuredRunSchema(output: Record<string, unknown>): OutputSchema<AgentRunResult> {
  return {
    ...agentRunSchema,
    serialize: () => output,
  };
}

function validateRunWorkspaceOptions(options: AgentRunOptions): void {
  const newWorkspace = resolveNewWorkspaceKind(options);
  if (
    options.newWorkspace &&
    options.newWorkspace !== "local" &&
    options.newWorkspace !== "worktree"
  ) {
    throw {
      code: "INVALID_OPTIONS",
      message: `Unsupported new workspace kind: ${options.newWorkspace}`,
      details: "Use --new-workspace local or --new-workspace worktree",
    } satisfies CommandError;
  }

  if (options.newWorkspace && options.worktree) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--new-workspace and --worktree cannot be combined",
      details: "Use --new-workspace worktree and the supported worktree options",
    } satisfies CommandError;
  }

  const hasWorktreeCreationOptions = [
    options.worktreeMode,
    options.worktreeSlug,
    options.newBranch,
    options.base,
    options.branch,
    options.prNumber,
    options.forge,
  ].some((value) => value !== undefined);
  if (hasWorktreeCreationOptions && newWorkspace !== "worktree") {
    throw {
      code: "INVALID_OPTIONS",
      message: "Worktree options require --new-workspace worktree",
      details: "Usage: paseo run --new-workspace worktree [worktree options] <prompt>",
    } satisfies CommandError;
  }

  if (newWorkspace === "worktree") {
    try {
      buildRunWorkspaceSource(options, options.cwd ?? process.cwd());
    } catch (error) {
      throw {
        code: "INVALID_OPTIONS",
        message: error instanceof Error ? error.message : String(error),
      } satisfies CommandError;
    }
  }

  if (options.newWorkspace && options.workspace) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--new-workspace and --workspace cannot be combined",
      details: "Select an existing workspace or explicitly create a new one",
    } satisfies CommandError;
  }

  // COMPAT(worktreeRunFlag): --worktree implies a new worktree-isolated workspace.
  // Added in v0.2.0; remove after 2027-01-17.
  if (options.worktree && options.workspace) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--worktree and --workspace cannot be combined",
      details: "Use --new-workspace worktree instead of the legacy --worktree flag",
    } satisfies CommandError;
  }
}

/**
 * How an agent-scoped run (PASEO_AGENT_ID set) asks the daemon for placement.
 * The daemon gives every agent-created agent its own worktree unless the run
 * shares the checkout with a recorded reason, so the CLI must not pre-create a
 * workspace the daemon would only branch from again.
 */
export interface AgentScopedRunRequest {
  createLocalWorkspace: boolean;
  worktree?: CreateAgentWorktreeTarget;
  isolation?: CreateAgentIsolation;
}

function invalidOptions(message: string, details?: string): CommandError {
  return { code: "INVALID_OPTIONS", message, ...(details ? { details } : {}) };
}

export function resolveAgentScopedRunRequest(
  options: AgentRunOptions,
  callerAgentId: string | undefined,
): AgentScopedRunRequest | null {
  const shareCheckout = options.shareCheckout?.trim();
  if (options.shareCheckout !== undefined && !shareCheckout) {
    throw invalidOptions("--share-checkout requires a reason");
  }
  const unsandboxed = options.unsandboxed?.trim();
  if (options.unsandboxed !== undefined && !unsandboxed) {
    throw invalidOptions("--unsandboxed requires a reason");
  }
  if (!callerAgentId) {
    if (shareCheckout || unsandboxed) {
      throw invalidOptions(
        `${shareCheckout ? "--share-checkout" : "--unsandboxed"} only applies to agent-scoped runs`,
        "It is valid when PASEO_AGENT_ID is set; other runs never isolate by default",
      );
    }
    return null;
  }
  const isolation = buildAgentScopedIsolation(shareCheckout, unsandboxed);
  const sharesCheckout = isolation?.worktree === false;
  const newWorkspace = resolveNewWorkspaceKind(options);
  if (newWorkspace === "local") {
    if (!sharesCheckout) {
      throw invalidOptions(
        "Agent-scoped runs get their own worktree; --new-workspace local would share the checkout",
        "Pass --share-checkout <reason> to share it, or drop --new-workspace",
      );
    }
    return { createLocalWorkspace: true, isolation };
  }
  if (newWorkspace !== "worktree") {
    return { createLocalWorkspace: false, ...(isolation ? { isolation } : {}) };
  }
  if (sharesCheckout) {
    throw invalidOptions("--share-checkout cannot be combined with --new-workspace worktree");
  }
  const worktree = toAgentScopedWorktreeTarget(options);
  return {
    createLocalWorkspace: false,
    ...(worktree ? { worktree } : {}),
    ...(isolation ? { isolation } : {}),
  };
}

// One recorded reason covers every opt-out the run asks for.
function buildAgentScopedIsolation(
  shareCheckout: string | undefined,
  unsandboxed: string | undefined,
): CreateAgentIsolation | undefined {
  if (!shareCheckout && !unsandboxed) return undefined;
  const reasons = [...new Set([shareCheckout, unsandboxed].filter(Boolean))];
  return {
    worktree: !shareCheckout,
    ...(unsandboxed ? { sandbox: false } : {}),
    reason: reasons.join("; "),
  };
}

function toAgentScopedWorktreeTarget(
  options: AgentRunOptions,
): CreateAgentWorktreeTarget | undefined {
  const slug = options.worktreeSlug ?? options.worktree;
  if (options.forge !== undefined) {
    throw invalidOptions("--forge is not supported for agent-scoped runs");
  }
  switch (options.worktreeMode ?? "branch-off") {
    case "branch-off": {
      if (slug && options.newBranch && slug !== options.newBranch) {
        throw invalidOptions(
          "--worktree-slug cannot differ from --new-branch for agent-scoped runs",
        );
      }
      const newBranch = options.newBranch ?? slug;
      if (!newBranch) {
        if (options.base !== undefined) {
          throw invalidOptions("--base requires --new-branch for agent-scoped runs");
        }
        // Daemon default: a new worktree off the caller's current branch.
        return undefined;
      }
      return { mode: "branch-off", newBranch, ...(options.base ? { base: options.base } : {}) };
    }
    case "checkout-branch":
      if (slug) throw invalidOptions("--worktree-slug is not supported for checkout modes here");
      if (!options.branch) throw invalidOptions("--branch is required for checkout-branch");
      return { mode: "checkout-branch", branch: options.branch };
    case "checkout-pr": {
      if (slug) throw invalidOptions("--worktree-slug is not supported for checkout modes here");
      const prNumber = Number(options.prNumber);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        throw invalidOptions("--pr-number must be a positive integer");
      }
      return { mode: "checkout-pr", prNumber };
    }
    default:
      throw invalidOptions(`Unsupported worktree mode: ${String(options.worktreeMode)}`);
  }
}

function toCreateAgentPlacement(agentScoped: AgentScopedRunRequest | null): {
  worktree?: CreateAgentWorktreeTarget;
  isolation?: CreateAgentIsolation;
} {
  if (!agentScoped) return {};
  return {
    ...(agentScoped.worktree ? { worktree: agentScoped.worktree } : {}),
    ...(agentScoped.isolation ? { isolation: agentScoped.isolation } : {}),
  };
}

function reportSubagentIsolation(agent: AgentSnapshotPayload): void {
  const message = describeSubagentIsolation(agent);
  if (message) console.error(message);
  if (agent.labels[ISOLATION_SANDBOX_LABEL] === "opted-out") {
    console.error("Subagent runs without the nono sandbox");
  }
}

function describeSubagentIsolation(agent: AgentSnapshotPayload): string | null {
  switch (agent.labels[ISOLATION_WORKTREE_LABEL]) {
    case "created":
      return `Subagent runs in its own worktree: ${agent.cwd}`;
    case "opted-out":
      return `Subagent shares the checkout ${agent.cwd}`;
    case "not-git":
      return `Note: ${agent.cwd} is not inside a git repository, so the subagent shares that directory`;
    default:
      return null;
  }
}

function validateRunOptions(prompt: string, options: AgentRunOptions, outputSchema: unknown): void {
  if (!prompt || prompt.trim().length === 0) {
    throw {
      code: "MISSING_PROMPT",
      message: "A prompt is required",
      details: "Usage: paseo agent run [options] <prompt>",
    } satisfies CommandError;
  }

  validateRunWorkspaceOptions(options);

  if (outputSchema && runsInBackground(options)) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--output-schema cannot be used with --background",
      details: "Structured output requires waiting for the agent to finish",
    } satisfies CommandError;
  }
}

function runsInBackground(options: Pick<AgentRunOptions, "background" | "detach">): boolean {
  return Boolean(options.background || options.detach);
}

function parseWaitTimeoutOption(waitTimeout: string | undefined): number {
  if (!waitTimeout) return 0;
  try {
    const ms = parseDuration(waitTimeout);
    if (ms <= 0) {
      throw new Error("Timeout must be positive");
    }
    return ms;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "INVALID_TIMEOUT",
      message: "Invalid wait timeout value",
      details: message,
    } satisfies CommandError;
  }
}

function loadRunImages(
  imagePaths: string[] | undefined,
): Array<{ data: string; mimeType: string }> | undefined {
  if (!imagePaths || imagePaths.length === 0) return undefined;
  return imagePaths.map((imagePath) => {
    const resolvedPath = resolve(imagePath);
    try {
      const imageData = readFileSync(resolvedPath);
      const mimeType = lookup(resolvedPath) || "application/octet-stream";
      if (!mimeType.startsWith("image/")) {
        throw new Error(`File is not an image: ${imagePath} (detected type: ${mimeType})`);
      }
      return {
        data: imageData.toString("base64"),
        mimeType,
      };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read image ${imagePath}: ${message}`, { cause: err });
    }
  });
}

function parseRunLabels(labelFlags: string[] | undefined): Record<string, string> {
  return parseKeyValueFlags(labelFlags, {
    flagName: "--label",
    code: "INVALID_LABEL",
    noun: "label",
    pluralNoun: "Labels",
  });
}

function parseRunEnv(envFlags: string[] | undefined): Record<string, string> {
  return parseKeyValueFlags(envFlags, {
    flagName: "--env",
    code: "INVALID_ENV",
    noun: "environment variable",
    pluralNoun: "Environment variables",
  });
}

function parseKeyValueFlags(
  flags: string[] | undefined,
  options: {
    flagName: string;
    code: CommandError["code"];
    noun: string;
    pluralNoun: string;
  },
): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!flags) return labels;
  for (const labelStr of flags) {
    const eqIndex = labelStr.indexOf("=");
    if (eqIndex === -1) {
      throw {
        code: options.code,
        message: `Invalid ${options.noun} format: ${labelStr}`,
        details: `${options.pluralNoun} must be in key=value format`,
      } satisfies CommandError;
    }
    const key = labelStr.slice(0, eqIndex);
    labels[key] = labelStr.slice(eqIndex + 1);
  }
  return labels;
}

// A workspace is the explicit home of a run: it owns the directory the agent
// runs in. The CLI resolves one before creating any agent, so no run leans on
// createAgent's legacy cwd->workspace fallback.
interface RunWorkspace {
  id?: string;
  cwd: string;
}

export interface RunWorkspaceLookupClient {
  fetchWorkspaces(options: { filter: { query: string }; page: { limit: number } }): Promise<{
    entries: Array<{ id: string; workspaceDirectory: string }>;
    pageInfo: { nextCursor: string | null };
  }>;
}

export async function resolveExistingRunWorkspace(
  client: RunWorkspaceLookupClient,
  workspaceId: string,
): Promise<RunWorkspace> {
  const result = await client.fetchWorkspaces({
    filter: { query: workspaceId },
    page: { limit: 200 },
  });
  const workspace = result.entries.find((entry) => entry.id === workspaceId);
  if (workspace) {
    return { id: workspace.id, cwd: workspace.workspaceDirectory };
  }

  throw {
    code: "WORKSPACE_NOT_FOUND",
    message: `Workspace not found: ${workspaceId}`,
  } satisfies CommandError;
}

// Workspace policy for `paseo run`. Precedence:
//   1. --workspace <id>            -> run in that existing workspace (agent-scoped: its
//                                     checkout is the source of the new worktree)
//   2. $PASEO_AGENT_ID             -> daemon places the subagent: a new worktree by
//                                     default, the caller workspace with --share-checkout
//   3. $PASEO_WORKSPACE_ID         -> exported by workspace terminals
//   4. --new-workspace <kind>      -> mint a new workspace explicitly
//   5. bare run                    -> mint a new local-backed workspace for cwd
async function resolveRunWorkspace(
  client: ConnectedDaemonClient,
  options: AgentRunOptions,
  cwd: string,
  agentScoped: AgentScopedRunRequest | null,
): Promise<RunWorkspace> {
  const newWorkspace = resolveNewWorkspaceKind(options);
  const explicit = newWorkspace ? undefined : options.workspace?.trim();
  if (explicit) {
    console.error(`Using workspace ${explicit}`);
    return resolveExistingRunWorkspace(client, explicit);
  }

  if (agentScoped && !agentScoped.createLocalWorkspace) {
    return { cwd };
  }

  const ambientWorkspaceId = newWorkspace ? undefined : process.env.PASEO_WORKSPACE_ID?.trim();
  if (ambientWorkspaceId) {
    console.error(`Using workspace ${ambientWorkspaceId}`);
    return resolveExistingRunWorkspace(client, ambientWorkspaceId);
  }

  // TODO: thread the run `prompt` as firstAgentContext so workspace-level
  // title/branch generation picks up the task description (U8/U6 deferred).
  const source = buildRunWorkspaceSource(options, cwd);
  const result = await client.createWorkspace({ source });

  if (!result.workspace) {
    throw {
      code: "WORKSPACE_CREATE_FAILED",
      message: result.error ?? "Failed to create workspace for this run",
    } satisfies CommandError;
  }

  const branch = result.workspace.gitRuntime?.currentBranch;
  const label = branch ? `${result.workspace.name} (${branch})` : result.workspace.name;
  console.error(`Created workspace ${result.workspace.id} - ${label}`);
  if (result.setupSkippedReason) console.error(result.setupSkippedReason);
  console.error(
    "Tip: pass --workspace <id> (or set PASEO_WORKSPACE_ID) to run in an existing workspace.",
  );
  return { id: result.workspace.id, cwd: result.workspace.workspaceDirectory ?? cwd };
}

export async function runRunCommand(
  prompt: string,
  options: AgentRunOptions,
  _command: Command,
): Promise<SingleResult<AgentRunResult>> {
  const outputSchema = options.outputSchema ? loadOutputSchema(options.outputSchema) : undefined;

  validateRunOptions(prompt, options, outputSchema);
  const callerAgentId = resolveRunCallerAgentId();
  const agentScoped = resolveAgentScopedRunRequest(options, callerAgentId);
  const waitTimeoutMs = parseWaitTimeoutOption(options.waitTimeout);

  const resolvedProviderModel = resolveProviderAndModel(options);
  const resolvedTitle = options.title ?? options.name;

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    // Resolve working directory
    const cwd = options.cwd ?? process.cwd();
    const thinkingOptionId = options.thinking?.trim();
    if (options.thinking !== undefined && !thinkingOptionId) {
      const error: CommandError = {
        code: "INVALID_THINKING_OPTION",
        message: "--thinking cannot be empty",
        details:
          'Provide a thinking option ID. Use "paseo provider models <provider> --thinking" to list valid IDs.',
      };
      throw error;
    }

    const images = loadRunImages(options.image);

    const labels = parseRunLabels(options.label);
    const env = parseRunEnv(options.env);
    const requestEnv = Object.keys(env).length > 0 ? env : undefined;

    const workspace = await resolveRunWorkspace(client, options, cwd, agentScoped);
    const workspaceId = workspace.id;
    const runCwd = workspace.cwd;
    const placement = toCreateAgentPlacement(agentScoped);

    if (outputSchema) {
      let structuredAgent: AgentSnapshotPayload | null = null;

      const callStructuredTurn = async (structuredPrompt: string): Promise<string> => {
        if (!structuredAgent) {
          structuredAgent = await client.createAgent({
            provider: resolvedProviderModel.provider,
            cwd: runCwd,
            workspaceId,
            callerAgentId,
            title: resolvedTitle,
            modeId: options.mode,
            model: resolvedProviderModel.model,
            thinkingOptionId,
            initialPrompt: structuredPrompt,
            outputSchema,
            images,
            env: requestEnv,
            labels: Object.keys(labels).length > 0 ? labels : undefined,
            ...placement,
          });
          reportSubagentIsolation(structuredAgent);
        } else {
          await client.sendMessage(structuredAgent.id, structuredPrompt);
        }

        const state = await client.waitForFinish(structuredAgent.id, waitTimeoutMs);
        if (state.status === "timeout") {
          throw new StructuredRunStatusError("timeout", "Timed out waiting for structured output");
        }
        if (state.status === "permission") {
          throw new StructuredRunStatusError(
            "permission",
            "Agent is waiting for permission before producing structured output",
          );
        }
        if (state.status === "error") {
          throw new StructuredRunStatusError(
            "error",
            state.error ?? "Agent failed before producing structured output",
          );
        }

        const lastMessage = await resolveStructuredResponseMessage({
          client,
          agentId: structuredAgent.id,
          lastMessage: state.lastMessage,
        });
        if (!lastMessage) {
          throw new StructuredRunStatusError(
            "empty",
            "Agent finished without a structured output message",
          );
        }

        return lastMessage;
      };

      const output = await fetchStructuredOutput(callStructuredTurn, prompt, outputSchema);

      if (!structuredAgent) {
        const error: CommandError = {
          code: "OUTPUT_SCHEMA_FAILED",
          message: "Agent finished without a structured output message",
        };
        throw error;
      }

      await client.close();

      return {
        type: "single",
        data: toRunResult(structuredAgent, "completed"),
        schema: structuredRunSchema(output),
      };
    }

    // Create the agent
    const agent = await client.createAgent({
      provider: resolvedProviderModel.provider,
      cwd: runCwd,
      workspaceId,
      callerAgentId,
      title: resolvedTitle,
      modeId: options.mode,
      model: resolvedProviderModel.model,
      thinkingOptionId,
      initialPrompt: prompt,
      images,
      env: requestEnv,
      labels: Object.keys(labels).length > 0 ? labels : undefined,
      ...placement,
    });
    reportSubagentIsolation(agent);

    // Default run behavior is foreground: wait for completion unless background execution is set.
    if (!runsInBackground(options)) {
      const state = await client.waitForFinish(agent.id, waitTimeoutMs);
      await client.close();

      const finalAgent = state.final ?? agent;
      const status: AgentRunResult["status"] = state.status === "idle" ? "completed" : state.status;

      return {
        type: "single",
        data: toRunResult(finalAgent, status),
        schema: agentRunSchema,
      };
    }

    await client.close();

    return {
      type: "single",
      data: toRunResult(agent),
      schema: agentRunSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "AGENT_CREATE_FAILED",
      message: `Failed to create agent: ${message}`,
    };
    throw error;
  }
}

export function resolveRunCallerAgentId(
  env: { PASEO_AGENT_ID?: string } = process.env,
): string | undefined {
  return env.PASEO_AGENT_ID?.trim() || undefined;
}
