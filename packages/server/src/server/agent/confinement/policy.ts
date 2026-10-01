import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

export const WriteConfinementRequestSchema = z
  .object({
    mode: z.enum(["off", "worktree", "read-only"]),
    scratchRoots: z.array(z.string()).default([]),
  })
  .strict();

export type WriteConfinementRequest = z.infer<typeof WriteConfinementRequestSchema>;

export interface WriteConfinementPolicy {
  version: 2;
  mode: "worktree" | "read-only";
  worktreeRoot: string;
  writableRoots: readonly string[];
  readableRoots: readonly string[];
  credentialRoots: readonly string[];
  rootIdentities: readonly RootIdentity[];
  network: "none";
  digest: string;
}

export interface RootIdentity {
  path: string;
  device: string;
  inode: string;
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
  /** Trusted host allowlist, including sanctioned fixture directories. */
  readableRoots?: readonly string[];
}): Promise<WriteConfinementPolicy> {
  const worktreeRoot = await canonicalDirectory(input.worktreeRoot);
  const scratch = await Promise.all(input.scratchRoots.map(canonicalDirectory));
  const writableRoots = [
    ...new Set(input.mode === "worktree" ? [worktreeRoot, ...scratch] : scratch),
  ].sort();
  const home = await realpath(os.homedir());
  const credentialRoots = [
    ".config/gh",
    ".config/git",
    ".gitconfig",
    ".git-credentials",
    ".ssh",
    ".netrc",
    ".npmrc",
    ".aws",
    ".config/gcloud",
    ".local/share/keyrings",
    ".local/share/opencode",
    "Library/Keychains",
  ].map((relative) => path.join(home, relative));
  const readableRoots = [
    ...new Set([
      worktreeRoot,
      ...writableRoots,
      ...(await Promise.all((input.readableRoots ?? []).map(canonicalDirectory))),
    ]),
  ].sort();
  for (const root of readableRoots) {
    if (
      credentialRoots.some((credential) => contains(root, credential) || contains(credential, root))
    ) {
      throw new ConfinementRefusal(
        "invalid-root",
        "a grant overlaps a host credential store",
        root,
      );
    }
  }
  for (const root of writableRoots) await rejectSharedObjects(root);
  const rootIdentities = await Promise.all(
    readableRoots.map(async (root) => {
      const info = await lstat(root, { bigint: true });
      if (!info.isDirectory())
        throw new ConfinementRefusal("invalid-root", "a grant changed during admission", root);
      return Object.freeze({ path: root, device: String(info.dev), inode: String(info.ino) });
    }),
  );
  const policy = {
    version: 2 as const,
    mode: input.mode,
    worktreeRoot,
    writableRoots,
    readableRoots,
    credentialRoots,
    rootIdentities,
    network: "none" as const,
  };
  const digest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  return Object.freeze({
    ...policy,
    writableRoots: Object.freeze(writableRoots),
    readableRoots: Object.freeze(readableRoots),
    credentialRoots: Object.freeze(credentialRoots),
    rootIdentities: Object.freeze(rootIdentities),
    digest,
  });
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
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
