import { constants, existsSync, realpathSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { ConfinementRefusal, type WriteConfinementPolicy } from "./policy.js";

export interface LinuxMount {
  path: string;
  writable: boolean;
  handle: FileHandle;
}

/** Pin sources before bubblewrap changes namespaces; paths can be replaced by another process. */
export async function openLinuxMounts(policy: WriteConfinementPolicy): Promise<LinuxMount[]> {
  const system = [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/etc/ld.so.cache",
    "/etc/localtime",
    process.execPath,
  ]
    .filter(existsSync)
    .map((root) => realpathSync(root));
  const roots = [...new Set([...system, ...policy.readableRoots])].sort();
  const mounts: LinuxMount[] = [];
  try {
    for (const root of roots) {
      if (
        policy.credentialRoots.some(
          (credential) =>
            root === credential ||
            root.startsWith(`${credential}/`) ||
            credential.startsWith(`${root}/`),
        )
      )
        throw new ConfinementRefusal(
          "invalid-root",
          "a system mount overlaps a credential store",
          root,
        );
      const handle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW);
      mounts.push({ path: root, writable: policy.writableRoots.includes(root), handle });
      const expected = policy.rootIdentities.find((entry) => entry.path === root);
      if (expected) {
        const actual = await handle.stat({ bigint: true });
        if (String(actual.dev) !== expected.device || String(actual.ino) !== expected.inode)
          throw new ConfinementRefusal(
            "invalid-root",
            "a grant was replaced before mount admission",
            root,
          );
      }
    }
    return mounts;
  } catch (error) {
    await closeLinuxMounts(mounts);
    throw error;
  }
}

export async function closeLinuxMounts(mounts: readonly LinuxMount[]): Promise<void> {
  await Promise.all(mounts.map((mount) => mount.handle.close()));
}
