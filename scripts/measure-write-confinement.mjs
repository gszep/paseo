import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareWritePolicy } from "../packages/server/src/server/agent/confinement/policy.ts";
import { spawnConfinedExecution } from "../packages/server/src/server/agent/confinement/execution.ts";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paseo-launch-benchmark-")));
try {
  const policy = await prepareWritePolicy({
    worktreeRoot: root,
    mode: "worktree",
    scratchRoots: [],
  });
  const samples = { plain: [], confined: [] };
  for (let index = 0; index < 45; index++) {
    const start = performance.now();
    const plain = spawn("/usr/bin/true", [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const [code] = await once(plain, "close");
    if (code !== 0) throw new Error(`Baseline exited ${code}`);
    const middle = performance.now();
    const job = await spawnConfinedExecution({
      identity: {
        agentId: "benchmark",
        sessionId: "benchmark",
        turnId: "benchmark",
        toolCallId: "benchmark",
      },
      policy,
      cwd: root,
      command: "/usr/bin/true",
      args: [],
      env: {},
      record: () => {},
    });
    let stderr = "";
    job.process.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    job.process.stdin.end();
    const closed = once(job.process, "close");
    const outcome = await job.rootExited;
    await closed;
    if (outcome.exitCode !== 0) throw new Error(`Sandbox exited ${outcome.exitCode}: ${stderr}`);
    if (index >= 5) {
      samples.plain.push(middle - start);
      samples.confined.push(performance.now() - middle);
    }
  }
  const summarize = (values) => {
    values.sort((a, b) => a - b);
    return { samples: values.length, p50Ms: values[19], p95Ms: values[37], p99Ms: values[39] };
  };
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        kernel: os.release(),
        node: process.version,
        scope:
          "empty-worktree /usr/bin/true wall time; includes per-execution policy scan; excludes module load and initial policy preparation",
        plain: summarize(samples.plain),
        confined: summarize(samples.confined),
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
