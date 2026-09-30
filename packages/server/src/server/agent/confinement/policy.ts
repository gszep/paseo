import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const WriteConfinementRequestSchema = z
  .object({
    mode: z.enum(["off", "worktree", "read-only"]),
    scratchRoots: z.array(z.string()).default([]),
  })
  .strict();

export type WriteConfinementRequest = z.infer<typeof WriteConfinementRequestSchema>;

export interface WriteConfinementPolicy {
  version: 1;
  mode: "worktree" | "read-only";
  worktreeRoot: string;
  writableRoots: readonly string[];
  network: "none";
  digest: string;
}

export class ConfinementRefusal extends Error {
  constructor(
    readonly reason:
      | "invalid-root"
      | "shared-inode"
      | "special-file"
      | "unsupported-platform"
      | "integration-unavailable",
    message: string,
    readonly target: string | null = null,
  ) {
    super(`Write confinement refused: ${message}`);
    this.name = "ConfinementRefusal";
  }
}

export async function prepareWritePolicy(input: {
  worktreeRoot: string;
  mode: "worktree" | "read-only";
  scratchRoots: readonly string[];
}): Promise<WriteConfinementPolicy> {
  const worktreeRoot = await canonicalDirectory(input.worktreeRoot);
  const scratch = await Promise.all(input.scratchRoots.map(canonicalDirectory));
  const writableRoots = [
    ...new Set(input.mode === "worktree" ? [worktreeRoot, ...scratch] : scratch),
  ].sort();
  for (const root of writableRoots) await rejectSharedObjects(root);
  const policy = {
    version: 1 as const,
    mode: input.mode,
    worktreeRoot,
    writableRoots,
    network: "none" as const,
  };
  const digest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  return Object.freeze({ ...policy, writableRoots: Object.freeze(writableRoots), digest });
}

async function canonicalDirectory(root: string): Promise<string> {
  const hasControl = [...root].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
  if (!path.isAbsolute(root) || hasControl) {
    throw new ConfinementRefusal(
      "invalid-root",
      "write roots must be absolute directory paths without control characters",
      root,
    );
  }
  const canonical = await realpath(root);
  if (canonical === path.parse(canonical).root || !(await lstat(canonical)).isDirectory()) {
    throw new ConfinementRefusal(
      "invalid-root",
      "a filesystem root or non-directory cannot be a write grant",
      canonical,
    );
  }
  return canonical;
}

// Never follow symlinks: their referents are checked by the kernel at use time.
// Admission is NOT an atomic snapshot. A concurrent unconfined writer can still
// introduce shared inodes after this check; production admission stays closed.
async function rejectSharedObjects(root: string): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    const info = await lstat(current);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      const entries = await readdir(current);
      pending.push(...entries.map((entry) => path.join(current, entry)));
    } else if (info.isFile()) {
      if (info.nlink > 1) {
        throw new ConfinementRefusal(
          "shared-inode",
          "a writable file has multiple hardlinks; use an independent install/copy",
          current,
        );
      }
    } else {
      throw new ConfinementRefusal(
        "special-file",
        "writable roots cannot contain host sockets, FIFOs, or devices",
        current,
      );
    }
  }
}
