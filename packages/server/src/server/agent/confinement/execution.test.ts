import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
  link,
  stat,
  open,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareWritePolicy, type WriteConfinementPolicy } from "./policy.js";
import { spawnConfinedExecution, type GuardrailEvent } from "./execution.js";

const identity = { agentId: "builder", sessionId: "session", turnId: "turn", toolCallId: "tool" };
const supported = process.platform === "darwin" || process.platform === "linux";

describe.skipIf(!supported)("experimental OS write boundary", () => {
  let root: string;
  let worktree: string;
  let outside: string;
  let scratch: string;
  let sentinel: string;
  let policy: WriteConfinementPolicy;
  let events: GuardrailEvent[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paseo-confinement-")));
    worktree = path.join(root, "worktree");
    outside = path.join(root, "other-checkout");
    scratch = path.join(root, "scratch");
    await Promise.all([worktree, outside, scratch].map((dir) => mkdir(dir)));
    sentinel = path.join(outside, "sentinel");
    await writeFile(sentinel, "unchanged");
    policy = await prepareWritePolicy({
      worktreeRoot: worktree,
      mode: "worktree",
      scratchRoots: [scratch],
    });
    events = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function run(command: string, args: string[], selected = policy) {
    const execution = await spawnConfinedExecution({
      identity,
      policy: selected,
      cwd: worktree,
      command,
      args,
      env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: scratch },
      record: (event) => events.push(event),
    });
    let stdout = "";
    let stderr = "";
    execution.process.stdout!.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    execution.process.stderr!.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    execution.process.stdin!.end();
    const closed = once(execution.process, "close");
    const outcome = await execution.rootExited;
    await closed;
    return { stdout, stderr, outcome, executionId: execution.executionId };
  }

  async function denied(source: string) {
    const result = await run(process.execPath, [
      "-e",
      `
      const fs = require('node:fs');
      try { ${source}; process.exitCode = 90; }
      catch (error) { console.log(error.code); }
    `,
    ]);
    expect(result.outcome.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^(EPERM|EROFS|EACCES|EXDEV)$/u);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  }

  it("allows worktree and explicit scratch writes, and outside reads", async () => {
    const result = await run(process.execPath, [
      "-e",
      `
      const fs = require('node:fs');
      fs.writeFileSync('allowed', 'yes');
      fs.writeFileSync(${JSON.stringify(path.join(scratch, "cache"))}, 'yes');
      console.log(fs.readFileSync(${JSON.stringify(sentinel)}, 'utf8'));
    `,
    ]);
    expect(result.outcome.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("unchanged");
    expect(await readFile(path.join(worktree, "allowed"), "utf8")).toBe("yes");
    expect(await readFile(path.join(scratch, "cache"), "utf8")).toBe("yes");
  });

  it("resolves a symlinked worktree once without granting its parent", async () => {
    const alias = path.join(root, "alias");
    await symlink(worktree, alias);
    const canonical = await prepareWritePolicy({
      worktreeRoot: alias,
      mode: "worktree",
      scratchRoots: [scratch],
    });
    expect(canonical).toEqual(policy);
  });

  it("refuses writes through a symlink ancestor", async () => {
    await symlink(outside, path.join(worktree, "escape"));
    await denied(`fs.writeFileSync('escape/sentinel', 'changed')`);
  });

  it("refuses writes after a symlink is swapped inside the sandbox", async () => {
    await mkdir(path.join(worktree, "safe"));
    await symlink(path.join(worktree, "safe"), path.join(worktree, "swap"));
    await denied(
      `fs.unlinkSync('swap'); fs.symlinkSync(${JSON.stringify(outside)}, 'swap'); fs.writeFileSync('swap/sentinel', 'changed')`,
    );
  });

  it("refuses the September 30 ln -sfn loop through symlinked node_modules", async () => {
    const target = path.join(outside, "node_modules");
    await mkdir(target);
    await symlink("original-package", path.join(target, "a"));
    await symlink(target, path.join(worktree, "node_modules"));
    const result = await run("/bin/sh", [
      "-c",
      'for package in a b; do ln -sfn /replacement "node_modules/$package" || exit; done',
    ]);
    expect(result.outcome.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(
      /(Operation not permitted|Read-only file system|Permission denied)/u,
    );
    const { readlink } = await import("node:fs/promises");
    expect(await readlink(path.join(target, "a"))).toBe("original-package");
    await expect(stat(path.join(target, "b"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects existing hardlink aliases at admission, before spawning", async () => {
    await link(sentinel, path.join(worktree, "alias"));
    await expect(
      run(process.execPath, ["-e", "require('fs').writeFileSync('alias', 'changed')"]),
    ).rejects.toMatchObject({ reason: "shared-inode" });
    expect(events.map((event) => event.outcome)).toEqual(["launch-refused"]);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
  });

  it("refuses new hardlink aliases in the kernel", async () => {
    await denied(`fs.linkSync(${JSON.stringify(sentinel)}, 'alias')`);
  });

  it.each(["unlink", "rename-in", "rename-out", "chmod", "fchmod", "utimes", "truncate"])(
    "refuses %s outside the worktree",
    async (operation) => {
      await writeFile(path.join(worktree, "source"), "source");
      const target = JSON.stringify(sentinel);
      const operations: Record<string, string> = {
        unlink: `fs.unlinkSync(${target})`,
        "rename-in": `fs.renameSync(${target}, 'stolen')`,
        "rename-out": `fs.renameSync('source', ${target})`,
        chmod: `fs.chmodSync(${target}, 0o600)`,
        fchmod: `const fd = fs.openSync(${target}, 'r'); fs.fchmodSync(fd, 0o600)`,
        utimes: `fs.utimesSync(${target}, 0, 0)`,
        truncate: `fs.truncateSync(${target}, 0)`,
      };
      const before = await stat(sentinel);
      await denied(operations[operation]);
      const after = await stat(sentinel);
      expect(after.mode).toBe(before.mode);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    },
  );

  it("keeps detached descendants confined", async () => {
    const child = `const fs=require('fs'); try { fs.writeFileSync(${JSON.stringify(sentinel)}, 'changed'); console.log('ESCAPED'); } catch(e) { console.log(e.code); }`;
    const result = await run(process.execPath, [
      "-e",
      `
      require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    `,
    ]);
    expect(result.outcome.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^(EPERM|EROFS|EACCES)$/u);
    expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    expect(result.outcome.coverage).toBe("incomplete");
  });

  it.each(["unix", "tcp"])("refuses host execution services over %s sockets", async (transport) => {
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    const socketPath = path.join(root, "host.sock");
    if (transport === "unix") server.listen(socketPath);
    else server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      const target =
        typeof address === "object" && address
          ? { host: "127.0.0.1", port: address.port }
          : socketPath;
      const result = await run(process.execPath, [
        "-e",
        `
        const socket = require('net').createConnection(${JSON.stringify(target)});
        socket.on('connect', () => { console.log('ESCAPED'); socket.end(); });
        socket.on('error', e => console.log(e.code));
      `,
      ]);
      expect(result.outcome.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim()).toMatch(/^(EPERM|EACCES)$/u);
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not implicitly allow shared Git metadata or package caches", async () => {
    const metadata = path.join(outside, ".git", "worktrees", "builder");
    await mkdir(metadata, { recursive: true });
    await writeFile(path.join(worktree, ".git"), `gitdir: ${metadata}\n`);
    await denied(`fs.writeFileSync(${JSON.stringify(path.join(metadata, "index.lock"))}, 'x')`);
    await denied(`fs.mkdirSync(${JSON.stringify(path.join(outside, ".npm"))})`);
    await expect(stat(path.join(metadata, "index.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps write-root quoting literal", async () => {
    const quoted = path.join(root, 'work "quoted" [x]');
    await mkdir(quoted);
    const selected = await prepareWritePolicy({
      worktreeRoot: quoted,
      mode: "worktree",
      scratchRoots: [],
    });
    const result = await run(
      process.execPath,
      ["-e", `require('fs').writeFileSync(${JSON.stringify(path.join(quoted, "allowed"))}, 'yes')`],
      selected,
    );
    expect(result.outcome.exitCode, result.stderr).toBe(0);
    expect(await readFile(path.join(quoted, "allowed"), "utf8")).toBe("yes");
  });

  it("does not inherit a writable FD even when the launcher process received it", async () => {
    const handle = await open(sentinel, "r+");
    try {
      const original = await handle.stat();
      const probe = `const fs = require('fs');
        for (let fd = 0; fd < 256; fd++) {
          let info; try { info = fs.fstatSync(fd); } catch { continue; }
          if (info.dev === ${original.dev} && info.ino === ${original.ino}) throw Error('inherited external inode');
        }
        console.log('external FD closed');`;
      const executorUrl = new URL("./execution.ts", import.meta.url).href;
      const bootstrap = `
        import {spawnConfinedExecution} from ${JSON.stringify(executorUrl)};
        import fs from 'node:fs';
        if (fs.fstatSync(5).size !== 9) throw Error('fixture FD not inherited');
        const job = await spawnConfinedExecution({
          identity: ${JSON.stringify(identity)}, policy: ${JSON.stringify(policy)}, cwd: ${JSON.stringify(worktree)},
          command: process.execPath, args: ['-e', ${JSON.stringify(probe)}],
          env: {}, record: () => {},
        });
        job.process.stdout.pipe(process.stdout); job.process.stderr.pipe(process.stderr);
        job.process.stdin.end(); await job.rootExited;
      `;
      const parent = spawn(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", bootstrap],
        {
          stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", handle.fd],
        },
      );
      let stdout = "";
      let stderr = "";
      parent.stdout!.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      parent.stderr!.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const [code] = await once(parent, "close");
      expect(code, stderr).toBe(0);
      expect(stdout.trim()).toBe("external FD closed");
      expect(await readFile(sentinel, "utf8")).toBe("unchanged");
    } finally {
      await handle.close();
    }
  });

  it("issues distinct trusted execution IDs for concurrent calls sharing a tool ID", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => run("/usr/bin/true", [])));
    expect(new Set(results.map((result) => result.executionId)).size).toBe(6);
    for (const result of results) {
      expect(result.outcome.exitCode, result.stderr).toBe(0);
      expect(
        events
          .filter((event) => event.executionId === result.executionId)
          .map((event) => event.outcome),
      ).toEqual(["started", "root-exited"]);
      expect(result.outcome).toMatchObject({
        cwd: worktree,
        worktreeRoot: worktree,
        policyDigest: policy.digest,
        identity,
        policyViolation: null,
        coverage: "incomplete",
      });
    }
  });

  it("read-only policy permits scratch but refuses worktree mutation", async () => {
    const readonly = await prepareWritePolicy({
      worktreeRoot: worktree,
      mode: "read-only",
      scratchRoots: [scratch],
    });
    const result = await run(
      process.execPath,
      ["-e", "require('fs').writeFileSync('forbidden', 'x')"],
      readonly,
    );
    expect(result.outcome.exitCode).toBe(1);
    expect(result.stderr).toMatch(/(EPERM|EROFS|EACCES)/u);
    await expect(stat(path.join(worktree, "forbidden"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
