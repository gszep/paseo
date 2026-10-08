import { afterEach, expect, test as platformTest, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHead,
  initialHead,
  type Json,
  type Pin,
} from "@henkaku-center/chi-native/append-codec";
import { captureAppend, type AppendCaptureInput } from "./append-capture.js";

// This writer is explicitly unavailable on Windows; its refusal is exercised
// through the real connection before credentials/native access in connection.test.
const test = platformTest.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const info = {
  id: "ses_append",
  projectID: "fixture",
  location: { directory: "/fixture" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
};
function message(index: number) {
  return {
    id: `msg_${index}`,
    type: "user",
    time: { created: index + 1 },
    text: `message ${index}`,
  };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "paseo-append-"));
  roots.push(home);
  const command = join(home, "scanner.cjs");
  await writeFile(
    command,
    `#!${process.execPath}\nconst fs=require('node:fs'); const args=process.argv.slice(2); if(args[0]==='version'){console.log('8.30.1');process.exit(0);} const dir=args.at(-1); const bytes=fs.readdirSync(dir).reduce((n,file)=>n+fs.statSync(dir+'/'+file).size,0); console.error('INF scanned ~'+bytes+' bytes ('+bytes+' bytes) in 1ms');`,
    { mode: 0o700 },
  );
  const calls: Json[] = [],
    entries: string[] = [],
    heads: string[] = [];
  let denied = false;
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    if (denied) return Response.json({ ok: false, reason: "not-found" }, { status: 404 });
    if (!heads.length) heads.push(initialHead(body.creation));
    expect(body.v).toBe(3);
    expect(body.bindingRevision).toBe(1);
    expect(body.expected.head).toBe(heads[body.expected.count]);
    const end = body.expected.count + body.entries.length;
    const replay = end <= entries.length;
    if (replay) expect(body.entries).toEqual(entries.slice(body.expected.count, end));
    else {
      expect(body.expected.count).toBe(entries.length);
      for (const text of body.entries) {
        heads.push(appendHead(heads.at(-1)!, entries.length, text));
        entries.push(text);
      }
    }
    return Response.json({
      pin: {
        v: 3,
        deployment: "fixture",
        repo: "github:fixture/repo",
        sourceId: body.sourceId,
        count: end,
        head: heads[end],
      },
      replay,
    });
  };
  const scanCapture = vi.fn<NonNullable<AppendCaptureInput["scanCapture"]>>(async () => ({
    verdict: "clean",
  }));
  const confirmed: Pin[] = [];
  const input: AppendCaptureInput = {
    home,
    endpoint: "https://fixture.invalid/api",
    deployment: "fixture",
    repo: "github:fixture/repo",
    actor: "github:alice",
    token: "synthetic",
    instanceId: "host:opencode",
    hostId: "host",
    sessionId: info.id,
    cwd: "/fixture",
    visibility: "shared",
    native: { info, messages: [message(0)] },
    expected: null,
    onConfirmed: async (pin) => {
      confirmed.push(pin);
    },
    request,
    scanner: { command },
    scanCapture,
  };
  return {
    input,
    entries,
    calls,
    confirmed,
    scanCapture,
    deny: () => {
      denied = true;
    },
  };
}

test("append capture projects and cut-scans only new messages, preserving confirmed coordinates through metadata", async () => {
  const f = await fixture();
  const first = await captureAppend(f.input);
  expect(first.messages.map((m) => [m.id, m.seq])).toEqual([["msg_0", 0]]);
  f.scanCapture.mockClear();
  const next = await captureAppend({
    ...f.input,
    expected: first.pin,
    native: { info: { ...info, title: "renamed" }, messages: [message(0), message(1)] },
  });
  expect(next.pin.count).toBe(3);
  expect(next.messages.map((m) => [m.id, m.seq])).toEqual([
    ["msg_0", 0],
    ["msg_1", 2],
  ]);
  expect(f.scanCapture).toHaveBeenCalledTimes(1);
  expect(JSON.parse(f.scanCapture.mock.calls[0]![0].native).messages).toEqual([message(1)]);
  expect(f.confirmed.map((pin) => pin.count)).toEqual([1, 3]);
  f.scanCapture.mockClear();
  await captureAppend({
    ...f.input,
    expected: next.pin,
    native: { info: { ...info, title: "renamed" }, messages: [message(0), message(1)] },
  });
  expect(f.scanCapture).not.toHaveBeenCalled();
  expect(f.entries).toHaveLength(3);
  f.deny();
  await expect(
    captureAppend({
      ...f.input,
      expected: next.pin,
      native: { info: { ...info, title: "renamed" }, messages: [message(0), message(1)] },
    }),
  ).rejects.toThrow("append-http-404");
});

test("native divergence and cut-scan rejection stop before another upload", async () => {
  const f = await fixture(),
    first = await captureAppend(f.input),
    calls = f.calls.length;
  await expect(
    captureAppend({
      ...f.input,
      expected: first.pin,
      native: { info, messages: [{ ...message(0), text: "edited" }, message(1)] },
    }),
  ).rejects.toThrow("append-recovery-required");
  expect(f.calls).toHaveLength(calls);
  f.scanCapture.mockRejectedValue(new Error("capture-local-secret-rejected"));
  await expect(
    captureAppend({
      ...f.input,
      expected: first.pin,
      native: { info, messages: [message(0), message(1)] },
    }),
  ).rejects.toThrow("capture-local-secret-rejected");
  expect(f.calls).toHaveLength(calls);
});

test("vendored policy transition preserves the old checkpoint and advances the same source on successive deltas", async () => {
  const f = await fixture();
  const first = await captureAppend(f.input);
  const root = join(f.input.home, "chi", "append");
  const files = await readdir(root, { recursive: true });
  const checkpointName = `confirmed-${first.pin.count}-${first.pin.head}`;
  const checkpoints = files.filter((file) => file.endsWith(checkpointName));
  expect(checkpoints).toHaveLength(1);
  const checkpointPath = join(root, checkpoints[0]!);
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  // Only this synthetic fixture is assigned the exact deployed predecessor
  // policy. Runtime upgrades must never rewrite an installed confirmation.
  checkpoint.scan.policy =
    "v3-raw-escaped-native-dfs-lf-r2-gitleaks-8.30.1-0ec357693c23c7a3ed01f9d5a2c2ab9d904da694d374cd2c07b776b9082c0cb3";
  const saved = JSON.stringify(checkpoint);
  await writeFile(checkpointPath, saved);
  const second = await captureAppend({
    ...f.input,
    expected: first.pin,
    native: { info, messages: [message(0), message(1)] },
  });
  expect(second.pin.sourceId).toBe(first.pin.sourceId);
  expect(second.pin.count).toBe(2);
  expect(await readFile(checkpointPath, "utf8")).toBe(saved);
  const nextPath = checkpointPath.replace(checkpointName, `confirmed-2-${second.pin.head}`);
  expect(JSON.parse(await readFile(nextPath, "utf8")).scan.policy).toBe(
    "v3-raw-escaped-native-dfs-lf-r2-gitleaks-8.30.1-f2fe8357db1f6d7e89769feab7df62159c949d9452b976456741d4382ec8ecb7",
  );
  const third = await captureAppend({
    ...f.input,
    expected: second.pin,
    native: { info, messages: [message(0), message(1), message(2)] },
  });
  expect(third.pin.sourceId).toBe(first.pin.sourceId);
  expect(third.pin.count).toBe(3);
  expect(f.confirmed.map((pin) => pin.count)).toEqual([1, 2, 3]);
  expect(await readFile(checkpointPath, "utf8")).toBe(saved);
});

test("a lost host checkpoint replays its durable request before constructing a new batch", async () => {
  const f = await fixture();
  await expect(
    captureAppend({
      ...f.input,
      onConfirmed: async () => {
        throw new Error("checkpoint lost");
      },
    }),
  ).rejects.toThrow("checkpoint lost");
  expect(f.entries).toHaveLength(1);
  const result = await captureAppend({
    ...f.input,
    native: { info, messages: [message(0), message(1)] },
  });
  expect(result.pin.count).toBe(2);
  expect(f.entries).toHaveLength(2);
  expect(f.confirmed.map((pin) => pin.count)).toEqual([1, 2]);
});

test("escaped native strings split before the one-request codec bound without splitting a record", async () => {
  const f = await fixture();
  const messages = Array.from({ length: 17 }, (_, index) => ({
    ...message(index),
    text: "\\".repeat(8000),
  }));
  const result = await captureAppend({ ...f.input, native: { info, messages } });
  expect(result.messages).toHaveLength(17);
  expect(f.entries).toHaveLength(17);
  expect(f.confirmed.length).toBeGreaterThan(1);
  for (const body of f.calls)
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(1024 * 1024);
});

test("initial coverage matches the frozen native-export digest, including fractions and numeric-looking keys", async () => {
  const f = await fixture();
  const native = {
    info: { ...info, cost: 0.125 },
    messages: [{ ...message(0), metadata: { "2": "two", "10": "ten" } }],
  };
  await captureAppend({ ...f.input, native });
  // Independent Python sorted-key JSON/SHA256 vector; a JSON.stringify-only
  // digest (or integer-only envelope encoder) does not satisfy this contract.
  expect(f.calls[0]).toMatchObject({
    creation: {
      coverage: { digest: "cd3ee8a262923ca7d81f72daf3e5169dec6bce5abed17db19ff55ffe7d51b180" },
    },
  });
});
