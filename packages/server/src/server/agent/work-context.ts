// Descriptive work context for the existing child -> parent finish notification.
//
// This is the canonical, versioned Paseo projection. It reads only an allowlisted
// set of existing agent labels plus the authoritative lifecycle/permission state.
// Labels are untrusted declarations (tools may update them), so the block is
// explicitly non-authoritative: it grants no access, bypasses no check and does
// not change runtime permissions. Missing values are omitted; lifecycle is
// reported separately from attention. Values are clipped and the whole payload
// is bounded and JSON-escaped before it is placed in the notification prompt.

export const WORK_CONTEXT_VERSION = "work-context/v0";

const WORK_CONTEXT_VALUE_LIMIT = 200;
const WORK_CONTEXT_BLOCK_LIMIT = 1024;

const WORK_LABELS = {
  workclass: "paseo.workclass",
  workmode: "paseo.workmode",
  task: "paseo.task",
  taskOwner: "paseo.task-owner",
  outcomeEvidence: "paseo.outcome-evidence",
  outcomeSource: "paseo.outcome-source",
  nextAction: "paseo.next-action",
  gate: "paseo.gate",
  budget: "paseo.budget",
  budgetShared: "paseo.budget-shared",
} as const;

const LIFECYCLE_VALUES = new Set(["initializing", "running", "idle", "error", "closed"]);
const WORKCLASS_VALUES = new Set(["delivery", "experiment", "sidequest"]);
const WORKMODE_VALUES = new Set(["research", "build", "review", "ops"]);
const OUTCOME_SOURCE_VALUES = new Set(["source", "merged", "deployed", "user-verified"]);

export interface WorkContextInput {
  childAgentId: string;
  labels?: Record<string, unknown> | null;
  lifecycle?: string | null;
  pendingPermissions?: number | null;
}

function readLabel(labels: Record<string, unknown>, key: string): string | undefined {
  const value = labels[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clip(value: string): string {
  return value.length > WORK_CONTEXT_VALUE_LIMIT
    ? `${value.slice(0, WORK_CONTEXT_VALUE_LIMIT)}[truncated]`
    : value;
}

function enumLabel(value: string | undefined, allowed: Set<string>): string | undefined {
  return value !== undefined && allowed.has(value) ? value : undefined;
}

function resolveLifecycle(value: string | null | undefined): string {
  return typeof value === "string" && LIFECYCLE_VALUES.has(value) ? value : "unknown";
}

// Attention needs a known cause. Running is not action-needed and idle without a
// next action is not a pending human decision. Only authoritative permission and
// error signals, or a declared next action, raise attention here. A gate label is
// reported as a declaration and never treated as observed external state.
export function deriveWorkContextAttention(input: {
  lifecycle: string;
  pendingPermissions?: number | null;
  nextAction?: string;
}): "human-decision" | "failure" | "owner-action" | "unknown" {
  if (
    typeof input.pendingPermissions === "number" &&
    Number.isFinite(input.pendingPermissions) &&
    input.pendingPermissions > 0
  ) {
    return "human-decision";
  }
  if (input.lifecycle === "error") return "failure";
  if (
    input.nextAction !== undefined &&
    (input.lifecycle === "idle" || input.lifecycle === "closed")
  ) {
    return "owner-action";
  }
  return "unknown";
}

function serialise(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

interface WorkContextFields {
  workclass?: string;
  workmode?: string;
  task?: string;
  taskOwner?: string;
  outcomeEvidence?: string;
  outcomeSource?: string;
  nextAction?: string;
  gate?: string;
  budget?: string;
  budgetShared?: string;
}

function readWorkContextFields(labels: Record<string, unknown>): WorkContextFields {
  return {
    workclass: enumLabel(readLabel(labels, WORK_LABELS.workclass), WORKCLASS_VALUES),
    workmode: enumLabel(readLabel(labels, WORK_LABELS.workmode), WORKMODE_VALUES),
    task: readLabel(labels, WORK_LABELS.task),
    taskOwner: readLabel(labels, WORK_LABELS.taskOwner),
    outcomeEvidence: readLabel(labels, WORK_LABELS.outcomeEvidence),
    outcomeSource: enumLabel(readLabel(labels, WORK_LABELS.outcomeSource), OUTCOME_SOURCE_VALUES),
    nextAction: readLabel(labels, WORK_LABELS.nextAction),
    gate: readLabel(labels, WORK_LABELS.gate),
    budget: readLabel(labels, WORK_LABELS.budget),
    budgetShared: readLabel(labels, WORK_LABELS.budgetShared),
  };
}

function buildWorkContextPayload(
  fields: WorkContextFields,
  input: WorkContextInput,
  lifecycle: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    version: WORK_CONTEXT_VERSION,
    childAgentId: clip(input.childAgentId),
    lifecycle,
    attention: deriveWorkContextAttention({
      lifecycle,
      pendingPermissions: input.pendingPermissions,
      nextAction: fields.nextAction,
    }),
    source: "paseo-agent-labels+lifecycle",
    trusted: false,
  };

  if (fields.workclass !== undefined) payload.workclass = fields.workclass;
  if (fields.workmode !== undefined) payload.workmode = fields.workmode;
  if (fields.task !== undefined) payload.task = clip(fields.task);
  if (fields.taskOwner !== undefined) payload.taskOwner = clip(fields.taskOwner);
  if (fields.nextAction !== undefined) payload.nextAction = clip(fields.nextAction);
  if (fields.gate !== undefined) payload.gateDeclared = clip(fields.gate);
  if (fields.outcomeEvidence !== undefined || fields.outcomeSource !== undefined) {
    payload.outcome = {
      ...(fields.outcomeEvidence !== undefined ? { evidence: clip(fields.outcomeEvidence) } : {}),
      ...(fields.outcomeSource !== undefined ? { source: fields.outcomeSource } : {}),
    };
  }
  if (fields.budget !== undefined || fields.budgetShared !== undefined) {
    payload.budget = {
      ...(fields.budget !== undefined ? { declared: clip(fields.budget) } : {}),
      ...(fields.budgetShared !== undefined ? { sharedRef: clip(fields.budgetShared) } : {}),
      enforced: false,
    };
  }
  return payload;
}

/**
 * Return a bounded `<work-context>` block, or null when no allowlisted work
 * label is present (so ordinary notifications stay unchanged).
 */
export function formatWorkContext(input: WorkContextInput): string | null {
  if (!input?.labels) return null;
  const fields = readWorkContextFields(input.labels);
  if (Object.values(fields).every((value) => value === undefined)) {
    return null;
  }

  const lifecycle = resolveLifecycle(input.lifecycle);
  const payload = buildWorkContextPayload(fields, input, lifecycle);
  let json = serialise(payload);
  if (json.length > WORK_CONTEXT_BLOCK_LIMIT) {
    json = serialise({
      version: WORK_CONTEXT_VERSION,
      childAgentId: clip(input.childAgentId),
      lifecycle,
      attention: payload.attention,
      source: "paseo-agent-labels+lifecycle",
      trusted: false,
      truncated: true,
    });
  }

  return `<work-context version="${WORK_CONTEXT_VERSION}">\n${json}\n</work-context>`;
}
