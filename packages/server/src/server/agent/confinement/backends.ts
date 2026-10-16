import type { WriteConfinementPolicy } from "./policy.js";
import { ConfinementRefusal } from "./policy.js";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { LinuxMount } from "./linux-mounts.js";

export interface SandboxCommand {
  command: string;
  args: string[];
  seccomp: Buffer | null;
}

export function sandboxCommand(input: {
  policy: WriteConfinementPolicy;
  executionId: string;
  command: string;
  args: readonly string[];
  platform?: NodeJS.Platform;
  arch?: string;
  mounts?: readonly LinuxMount[];
}): SandboxCommand {
  const platform = input.platform ?? process.platform;
  if (platform === "darwin") {
    const ancestors = new Set<string>();
    for (const root of [...input.policy.readableRoots, realpathSync(process.execPath)]) {
      let parent = path.dirname(root);
      while (parent !== path.dirname(parent)) {
        ancestors.add(parent);
        parent = path.dirname(parent);
      }
    }
    const reads = [
      "/System/Library",
      "/usr/lib",
      "/usr/bin",
      "/bin",
      "/sbin",
      "/Library/Apple/System/Library",
      ...input.policy.readableRoots,
    ].map((root) => `(allow file-read* (subpath ${JSON.stringify(root)}))`);
    const grants = input.policy.writableRoots.map(
      (root) => `(allow file-write* (subpath ${JSON.stringify(root)}))`,
    );
    // Protect grant roots themselves from being moved/replaced by the child.
    const roots = input.policy.writableRoots.map(
      (root) => `(deny file-write-unlink (literal ${JSON.stringify(root)}))`,
    );
    const profile = [
      "(version 1)",
      `(deny default (with message ${JSON.stringify(`PASEO_GUARD_${input.executionId}`)}))`,
      ...reads,
      ...[...ancestors].map(
        (root) => `(allow file-read-metadata (literal ${JSON.stringify(root)}))`,
      ),
      '(allow file-read* (literal "/"))',
      `(allow file-read* (literal ${JSON.stringify(realpathSync(process.execPath))}))`,
      '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
      ...input.policy.credentialRoots.map(
        (root) => `(deny file-read* (subpath ${JSON.stringify(root)}))`,
      ),
      '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.secd"))',
      "(allow process-exec process-fork)",
      "(allow process-info* (target same-sandbox))",
      "(allow signal (target same-sandbox))",
      "(allow sysctl-read)",
      '(allow file-write-data file-ioctl (literal "/dev/null"))',
      ...grants,
      ...roots,
      // No new inode aliases, including aliases to permitted files.
      "(deny file-link)",
      // These fcntls can mutate through a read-only descriptor (Codex's
      // seatbelt.rs documents why even deny-default needs this rule).
      "(deny system-fcntl (fcntl-command 80 110))",
    ].join("\n");
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", profile, input.command, ...input.args],
      seccomp: null,
    };
  }
  if (platform === "linux") {
    if (!input.mounts?.length)
      throw new ConfinementRefusal("invalid-root", "Linux mount sources must be pinned");
    return {
      command: "/usr/bin/bwrap",
      args: [
        "--unshare-all",
        "--unshare-user",
        "--die-with-parent",
        "--new-session",
        "--disable-userns",
        "--cap-drop",
        "ALL",
        ...input.mounts.flatMap((mount, index) => [
          mount.writable ? "--bind-fd" : "--ro-bind-fd",
          String(index + 4),
          mount.path,
        ]),
        // Preserve merged-/usr aliases without exposing the host root.
        ...["/bin", "/sbin", "/lib", "/lib64"]
          .filter(existsSync)
          .flatMap((root) =>
            realpathSync(root) === root ? [] : ["--symlink", realpathSync(root), root],
          ),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--seccomp",
        "3",
        "--",
        input.command,
        ...input.args,
      ],
      seccomp: socketAndAliasFilter(input.arch ?? process.arch),
    };
  }
  throw new ConfinementRefusal("unsupported-platform", `no write sandbox for ${platform}`);
}

// Classic BPF: validate audit arch before syscall numbers, reject x32, and
// return EPERM for host IPC, hardlinks and alternate kernel access mechanisms.
// All other syscalls remain subject to the read-only mount policy.
function socketAndAliasFilter(arch: string): Buffer {
  let auditArch: number;
  let denied: number[];
  if (arch === "x64") {
    auditArch = 0xc000003e;
    denied = [41, 86, 101, 265, 304, 311, 321, 425];
  } else if (arch === "arm64") {
    auditArch = 0xc00000b7;
    denied = [37, 117, 198, 265, 271, 280, 425];
  } else {
    throw new ConfinementRefusal("unsupported-platform", `no seccomp syscall table for ${arch}`);
  }
  const instructions: number[][] = [
    [0x20, 0, 0, 4], // seccomp_data.arch
    [0x15, 1, 0, auditArch],
    [0x06, 0, 0, 0x80000000], // KILL_PROCESS
    [0x20, 0, 0, 0], // seccomp_data.nr
    [0x35, 0, 1, 0x40000000],
    [0x06, 0, 0, 0x80000000],
  ];
  for (const syscall of denied) instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]);
  instructions.push([0x06, 0, 0, 0x7fff0000]);
  const filter = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    filter.writeUInt16LE(code, index * 8);
    filter.writeUInt8(jt, index * 8 + 2);
    filter.writeUInt8(jf, index * 8 + 3);
    filter.writeUInt32LE(k, index * 8 + 4);
  });
  return filter;
}
