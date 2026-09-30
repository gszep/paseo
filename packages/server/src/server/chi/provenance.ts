import {
  createProvenanceCommit,
  currentBranch,
  deriveTurnCoordinates,
  gitStdout,
  normalizeProvenanceUser,
  provenanceRefFor,
  purgeProvenanceRef,
  pushProvenanceRef,
  type ProvenanceOrigin,
} from "@henkaku-center/chi-native/provenance";
import {
  blameProvenanceFile,
  formatProvenanceBlame,
  walkProvenanceChain,
  type ProvenanceBlameRow,
} from "@henkaku-center/chi-native/provenance-blame";

/**
 * Daemon-side provenance writer. Runs after a settled turn in a mapped git
 * worktree, snapshotting the working tree into a hidden per-user ref. It never
 * moves HEAD, never touches the real index, secret-scans the diff, and pushes
 * with the user's own credentials. Failures are returned, never thrown, so they
 * can never block a prompt.
 */

export interface CaptureEvidence {
  nativeSessionId: string;
  nativeParent: { kind: "session-id" | "session-path"; value: string } | null;
  entries: ReadonlyArray<{ nativeId: string; type: string; parentId: string | null }>;
}

export interface ProvenanceWriteInput {
  root: string;
  /** Chi owner identity, e.g. `github:alice`. */
  user: string;
  sessionId: string;
  /** Normalized `github:owner/repo`. */
  repo: string;
  sourceId?: string | null;
  head?: string | null;
  evidence: CaptureEvidence;
  continuation?: boolean;
  delegation?: { parentSessionId: string; turnId?: string } | null;
  scanner?: string;
}

export interface ProvenanceOutcome {
  attempted: boolean;
  created: boolean;
  reason: string;
  ref: string;
  pushReason?: string;
}

export type ProvenanceWriter = (input: ProvenanceWriteInput) => ProvenanceOutcome;

export interface ProvenanceRemoveInput {
  root: string;
  user: string;
  sessionId: string;
  ref?: string;
}

export interface ProvenanceRemoval {
  removed: boolean;
  ref: string;
  reason: string;
}

export type ProvenanceRemover = (input: ProvenanceRemoveInput) => ProvenanceRemoval;

export function provenanceRefForSession(user: string, sessionId: string): string {
  return provenanceRefFor(normalizeProvenanceUser(user), sessionId);
}

function originFor(input: ProvenanceWriteInput): {
  origin: ProvenanceOrigin;
  originRef?: string;
} {
  if (input.delegation?.parentSessionId) {
    return {
      origin: "delegation",
      originRef: [input.delegation.parentSessionId, input.delegation.turnId]
        .filter(Boolean)
        .join("#"),
    };
  }
  const parent = input.evidence.nativeParent?.value;
  if (parent && input.continuation) return { origin: "continue", originRef: parent };
  if (parent) return { origin: "fork", originRef: parent };
  return { origin: "human-request" };
}

export function writeProvenance(input: ProvenanceWriteInput): ProvenanceOutcome {
  const ref = provenanceRefForSession(input.user, input.sessionId);
  try {
    const { origin, originRef } = originFor(input);
    const coordinates = {
      ...deriveTurnCoordinates(input.evidence.entries),
      sessionId: input.sessionId,
      origin,
      ...(originRef ? { originRef } : {}),
      agent: "opencode",
      repo: input.repo.replace(/^github:/i, ""),
      baseBranch: currentBranch(input.root),
      provenanceBranch: ref,
      ...(input.sourceId ? { chiSourceId: input.sourceId } : {}),
      ...(input.head ? { chiHeadRevision: input.head } : {}),
    };
    const result = createProvenanceCommit({
      root: input.root,
      coordinates,
      ...(input.scanner ? { scanner: input.scanner } : {}),
    });
    let pushReason = "not-pushed";
    if (gitStdout(input.root, ["rev-parse", "--verify", ref], { allowFailure: true })) {
      const push = pushProvenanceRef({ root: input.root, ref });
      pushReason = push.pushed ? "pushed" : "push-failed";
    }
    const reason = result.created
      ? pushReason === "pushed"
        ? "created-pushed"
        : "created-push-pending"
      : result.reason;
    return { attempted: true, created: result.created, reason, ref, pushReason };
  } catch (error) {
    return {
      attempted: true,
      created: false,
      reason: error instanceof Error ? error.message : "provenance-failed",
      ref,
    };
  }
}

export function removeProvenance(input: ProvenanceRemoveInput): ProvenanceRemoval {
  const ref = input.ref ?? provenanceRefForSession(input.user, input.sessionId);
  try {
    const result = purgeProvenanceRef({ root: input.root, ref });
    return { removed: result.remote, ref, reason: result.reason };
  } catch (error) {
    return {
      removed: false,
      ref,
      reason: error instanceof Error ? error.message : "provenance-purge-failed",
    };
  }
}

export interface BlameResult {
  rows: ProvenanceBlameRow[];
  rendered: string;
  ref: string;
}

/** Token-budgeted blame entry the future `chi_commons` blame op calls. */
export function blameProvenance(input: {
  root: string;
  ref: string;
  file: string;
  lineStart?: number;
  lineEnd?: number;
  tokenBudget?: number;
}): BlameResult {
  const rows = blameProvenanceFile({ root: input.root, ref: input.ref, file: input.file });
  const ranged = rows.filter(
    (row) =>
      (input.lineStart === undefined || row.line >= input.lineStart) &&
      (input.lineEnd === undefined || row.line <= input.lineEnd),
  );
  return {
    rows: ranged,
    rendered: formatProvenanceBlame(ranged, {
      file: input.file,
      ref: input.ref,
      ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
    }),
    ref: input.ref,
  };
}

export { walkProvenanceChain };
export type { ProvenanceBlameRow };
