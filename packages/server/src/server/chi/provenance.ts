import {
  currentBranch,
  deriveTurnCoordinates,
  normalizeProvenanceUser,
  provenanceRefFor,
  purgeProvenanceRef,
  writeProvenanceRef,
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
 * with the user's own credentials. Every git/scan/push call is async with a
 * timeout, and failures are returned, never thrown, so they cannot block a
 * prompt or the event loop.
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
  remote?: string;
}

export interface ProvenanceOutcome {
  attempted: boolean;
  created: boolean;
  reason: string;
  ref: string;
  pushReason?: string;
}

export type ProvenanceWriter = (input: ProvenanceWriteInput) => Promise<ProvenanceOutcome>;

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

export type ProvenanceRemover = (input: ProvenanceRemoveInput) => Promise<ProvenanceRemoval>;

const REASON_MAX = 120;

function boundedReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/[\r\n]+/g, " ").slice(0, REASON_MAX) || "provenance-failed";
}

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

export async function writeProvenance(input: ProvenanceWriteInput): Promise<ProvenanceOutcome> {
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
      baseBranch: await currentBranch(input.root),
      provenanceBranch: ref,
      ...(input.sourceId ? { chiSourceId: input.sourceId } : {}),
      ...(input.head ? { chiHeadRevision: input.head } : {}),
    };
    const result = await writeProvenanceRef({
      root: input.root,
      coordinates,
      ...(input.scanner ? { scanner: input.scanner } : {}),
      ...(input.remote ? { remote: input.remote } : {}),
    });
    const reason = result.created
      ? result.pushReason === "pushed"
        ? "created-pushed"
        : `created-${result.pushReason ?? "push-pending"}`
      : result.reason;
    return {
      attempted: true,
      created: result.created,
      reason,
      ref,
      pushReason: result.pushReason,
    };
  } catch (error) {
    return { attempted: true, created: false, reason: boundedReason(error), ref };
  }
}

export async function removeProvenance(input: ProvenanceRemoveInput): Promise<ProvenanceRemoval> {
  const ref = input.ref ?? provenanceRefForSession(input.user, input.sessionId);
  try {
    const result = await purgeProvenanceRef({ root: input.root, ref });
    return { removed: result.remote, ref, reason: result.reason };
  } catch (error) {
    return { removed: false, ref, reason: boundedReason(error) };
  }
}

export interface BlameResult {
  rows: ProvenanceBlameRow[];
  rendered: string;
  ref: string;
}

/** Token-budgeted blame entry the future `chi_commons` blame op calls. */
export async function blameProvenance(input: {
  root: string;
  ref: string;
  file: string;
  lineStart?: number;
  lineEnd?: number;
  maxRows?: number;
  tokenBudget?: number;
}): Promise<BlameResult> {
  // Range is applied before the row cap inside the library.
  const rows = await blameProvenanceFile({
    root: input.root,
    ref: input.ref,
    file: input.file,
    ...(input.lineStart !== undefined ? { lineStart: input.lineStart } : {}),
    ...(input.lineEnd !== undefined ? { lineEnd: input.lineEnd } : {}),
    ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
  });
  return {
    rows,
    rendered: formatProvenanceBlame(rows, {
      file: input.file,
      ref: input.ref,
      ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
    }),
    ref: input.ref,
  };
}

export { walkProvenanceChain };
export type { ProvenanceBlameRow };
