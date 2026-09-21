import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sessionId = z.string().regex(/^ses[a-zA-Z0-9_-]{1,200}$/);
const destination = z.object({
  instanceId: z.string(),
  workspace: z.object({ hostId: z.string(), path: z.string() }),
});
const journalSchema = z.object({
  identity: z.object({
    repo: z.string(),
    sourceId: hash,
    snapshotId: hash,
    endpoint: z.string(),
    actor: z.string(),
    workspaceId: z.string(),
    destination,
    canonical: z.object({ conversationId: z.string(), transferId: z.string() }),
  }),
  claim: z.object({ id: z.string(), transferId: z.string(), destination }),
});
const receiptSchema = z.object({
  version: z.literal(1),
  kind: z.literal("native-fork-continuation"),
  status: z.enum(["preparing", "importing", "imported", "forking", "verifying", "ready", "failed"]),
  failedAt: z
    .enum(["preparing", "importing", "imported", "forking", "verifying", "ready", "failed"])
    .optional(),
  turnStarted: z.literal(false),
  source: z.object({
    repo: z.string(),
    sourceId: hash,
    snapshotId: hash,
    nativeSessionId: sessionId.optional(),
  }),
  owner: z.object({ actor: z.string(), workspaceId: z.string(), endpoint: z.string() }),
  destination: z.object({
    origin: z.string(),
    workspace: z.string(),
    importedSessionId: sessionId.optional(),
    sessionId: sessionId.optional(),
    importDisposition: z.enum(["created", "reused"]).optional(),
  }),
});

export interface QuarantinedSession {
  sessionId: string;
  cwd: string;
  kind: "replica" | "fork";
}

function requirePrivate(stat: { mode: number; uid: number }): void {
  if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("chi-receipt-quarantine-unavailable");
}

async function privateJson(path: string): Promise<unknown | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    requirePrivate(stat);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new Error("chi-receipt-quarantine-unavailable");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

/** Local receipt ownership, never backend credentials or inferred child IDs.
 * Incomplete/corrupt private state fails closed; only the continuation owner can
 * recover a ready fork through a separately issued registration capability. */
export async function readQuarantinedSessions(
  home: string,
  serverId: string,
  endpoint: string,
): Promise<QuarantinedSession[]> {
  const directory = join(home, "chi", "receipts");
  try {
    let directoryStat;
    try {
      directoryStat = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    requirePrivate(directoryStat);
    if (!directoryStat.isDirectory()) throw new Error("chi-receipt-quarantine-unavailable");
    const result: QuarantinedSession[] = [];
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.claim\.json$/.test(name)) continue;
      const journal = journalSchema.parse(await privateJson(join(directory, name)));
      const identity = journal.identity;
      if (
        identity.destination.instanceId !== `${serverId}:opencode` ||
        identity.destination.workspace.hostId !== serverId ||
        identity.endpoint !== endpoint
      )
        continue;
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            identity.repo,
            identity.canonical.conversationId,
            identity.canonical.transferId,
          ]),
        )
        .digest("hex");
      if (
        name !== `${key}.claim.json` ||
        journal.claim.id !== identity.canonical.conversationId ||
        journal.claim.transferId !== identity.canonical.transferId ||
        JSON.stringify(journal.claim.destination) !== JSON.stringify(identity.destination)
      )
        throw new Error("chi-receipt-quarantine-unavailable");
      const saved = await privateJson(join(directory, `${key}.json`));
      if (saved === null) continue; // A claim with no native receipt names no native mutations.
      const receipt = receiptSchema.parse(saved);
      assertReceiptIdentity(receipt, identity);
      // The native fork may exist even though its reply/ID never reached this
      // receipt. No ordinary import in this owner namespace can distinguish it
      // from unrelated history until manual receipt recovery resolves the ID.
      const stage = receipt.status === "failed" ? receipt.failedAt : receipt.status;
      if (
        !receipt.destination.sessionId &&
        (stage === "forking" || stage === "verifying" || stage === "ready")
      )
        throw new Error("chi-receipt-quarantine-unavailable");
      result.push(...ownedSessions(receipt));
    }
    return result;
  } catch {
    throw new Error("chi-receipt-quarantine-unavailable");
  }
}

function assertReceiptIdentity(
  receipt: z.infer<typeof receiptSchema>,
  identity: z.infer<typeof journalSchema>["identity"],
): void {
  if (
    receipt.destination.origin !== identity.destination.instanceId ||
    receipt.destination.workspace !== identity.destination.workspace.path ||
    receipt.source.repo !== identity.repo ||
    receipt.source.sourceId !== identity.sourceId ||
    receipt.source.snapshotId !== identity.snapshotId ||
    receipt.owner.actor !== identity.actor ||
    receipt.owner.workspaceId !== identity.workspaceId ||
    receipt.owner.endpoint !== identity.endpoint
  )
    throw new Error("chi-receipt-quarantine-unavailable");
}

function ownedSessions(receipt: z.infer<typeof receiptSchema>): QuarantinedSession[] {
  const result: QuarantinedSession[] = [];
  const imported = receipt.destination.importedSessionId;
  // Earlier same-host sources are not newly owned replicas. Older receipts
  // without disposition can establish that identity through the source hash.
  const sameHostSource =
    imported &&
    createHash("sha256")
      .update(JSON.stringify(["opencode-v2", receipt.destination.origin, imported]))
      .digest("hex") === receipt.source.sourceId;
  if (
    imported &&
    receipt.destination.importDisposition !== "reused" &&
    (receipt.destination.importDisposition === "created" || !sameHostSource)
  )
    result.push({ sessionId: imported, cwd: receipt.destination.workspace, kind: "replica" });
  if (
    receipt.destination.importDisposition === "created" &&
    receipt.source.nativeSessionId &&
    receipt.source.nativeSessionId !== imported
  )
    result.push({
      sessionId: receipt.source.nativeSessionId,
      cwd: receipt.destination.workspace,
      kind: "replica",
    });
  const fork = receipt.destination.sessionId;
  if (fork && fork !== receipt.source.nativeSessionId && fork !== imported)
    result.push({ sessionId: fork, cwd: receipt.destination.workspace, kind: "fork" });
  return result;
}
