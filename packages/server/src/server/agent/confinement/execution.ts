import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { sandboxCommand } from "./backends.js";
import { prepareWritePolicy, type WriteConfinementPolicy } from "./policy.js";
import { openLinuxMounts, closeLinuxMounts, type LinuxMount } from "./linux-mounts.js";

export interface ExecutionIdentity {
  agentId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
}

export interface GuardrailEvent {
  type: "guardrail";
  executionId: string;
  identity: ExecutionIdentity;
  cwd: string;
  worktreeRoot: string;
  policyDigest: string;
  timestamp: string;
  pid: number | null;
  outcome: "started" | "root-exited" | "launch-refused";
  exitCode: number | null;
  signal: string | null;
  coverage: "incomplete";
  outsideWorktree: boolean | null;
  policyViolation: boolean | null;
  evidence: "launcher";
  message: string;
}

export interface ConfinedExecution {
  executionId: string;
  process: ChildProcess;
  rootExited: Promise<GuardrailEvent>;
}

/** Experimental process boundary. Not yet a production all-tools boundary. */
export async function spawnConfinedExecution(input: {
  identity: ExecutionIdentity;
  policy: WriteConfinementPolicy;
  cwd: string;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  record: (event: GuardrailEvent) => void;
}): Promise<ConfinedExecution> {
  // Generated in the trusted parent, never taken from argv, env or tool input.
  const executionId = randomUUID();
  const identity = Object.freeze({ ...input.identity });
  const cwd = await realpath(input.cwd);
  const event = (
    fields: Pick<GuardrailEvent, "pid" | "outcome" | "exitCode" | "signal" | "message">,
  ): GuardrailEvent => ({
    type: "guardrail",
    executionId,
    identity,
    cwd,
    worktreeRoot: input.policy.worktreeRoot,
    policyDigest: input.policy.digest,
    timestamp: new Date().toISOString(),
    coverage: "incomplete",
    outsideWorktree: null,
    policyViolation: null,
    evidence: "launcher",
    ...fields,
  });
  let launch;
  let mounts: LinuxMount[] = [];
  try {
    // Recheck at each execution. This does not close the external-writer race.
    const checked = await prepareWritePolicy({
      worktreeRoot: input.policy.worktreeRoot,
      mode: input.policy.mode,
      scratchRoots: input.policy.writableRoots,
      readableRoots: input.policy.readableRoots,
    });
    if (checked.digest !== input.policy.digest)
      throw new Error("Write roots changed since policy preparation");
    if (!path.isAbsolute(input.command))
      throw new Error("Confined executables must use absolute paths");
    const environment = Object.entries(input.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    for (const [key, value] of environment) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || value.includes("\0"))
        throw new Error("Invalid confined environment");
    }
    // Apply caller environment only AFTER sandbox entry. In particular,
    // LD_PRELOAD must never execute inside the unsandboxed bubblewrap loader.
    if (process.platform === "linux") mounts = await openLinuxMounts(checked);
    launch = sandboxCommand({
      policy: checked,
      executionId,
      mounts,
      command: "/usr/bin/env",
      args: [
        "-i",
        "--",
        ...environment.map(([key, value]) => `${key}=${value}`),
        input.command,
        ...input.args,
      ],
    });
  } catch (error) {
    await closeLinuxMounts(mounts);
    input.record(
      event({
        pid: null,
        outcome: "launch-refused",
        exitCode: null,
        signal: null,
        message: String(error),
      }),
    );
    throw error;
  }
  // The target receives only new standard-stream pipes. Bubblewrap additionally
  // receives the policy and pinned mount sources, which it consumes before exec.
  // Never inherit caller-provided descriptors, including standard streams.
  let child: ChildProcess;
  try {
    child = spawn(launch.command, launch.args, {
      cwd,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      shell: false,
      detached: false,
      stdio: launch.seccomp
        ? ["pipe", "pipe", "pipe", "pipe", ...mounts.map((mount) => mount.handle.fd)]
        : ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    await closeLinuxMounts(mounts);
    throw error;
  }
  if (launch.seccomp) {
    const fd = child.stdio[3];
    if (!fd || !("write" in fd)) throw new Error("Missing seccomp pipe");
    // bubblewrap consumes and closes this descriptor before exec.
    fd.on("error", () => undefined);
    Readable.from([launch.seccomp]).pipe(fd);
  }
  const rootExited = new Promise<GuardrailEvent>((resolve) => {
    let settled = false;
    const finish = (entry: GuardrailEvent) => {
      if (settled) return;
      settled = true;
      input.record(entry);
      resolve(entry);
    };
    child.once("spawn", () =>
      input.record(
        event({
          pid: child.pid ?? null,
          outcome: "started",
          exitCode: null,
          signal: null,
          message:
            "OS sandbox launcher started; descendant completion and denial coverage are not established",
        }),
      ),
    );
    child.once("error", (error) =>
      finish(
        event({
          pid: child.pid ?? null,
          outcome: "launch-refused",
          exitCode: null,
          signal: null,
          message: `Write confinement could not start: ${error.message}`,
        }),
      ),
    );
    child.once("exit", (exitCode, signal) =>
      finish(
        event({
          pid: child.pid ?? null,
          outcome: "root-exited",
          exitCode,
          signal,
          message:
            "Root process exited; this is not a descendant completion barrier or a clean-write verdict",
        }),
      ),
    );
  });
  await closeLinuxMounts(mounts);
  return { executionId, process: child, rootExited };
}
