import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { CoDriveDriver, type ControlSource } from "./co-drive.js";
import type { CoDriveGrant, CoDriveSend } from "@getpaseo/protocol/chi-mentions";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "co-drive-worker-"));
  homes.push(home);
  const source: ControlSource = {
    agentId: "agent",
    sourceId: "a".repeat(64),
    repo: "github:fixture/repo",
    endpoint: "https://fixture.invalid",
    actor: "github:alice",
    instanceId: "host:opencode",
    nativeSessionId: "ses_original",
    cwd: home,
    pin: {
      v: 3,
      deployment: "fixture",
      repo: "github:fixture/repo",
      sourceId: "a".repeat(64),
      count: 1,
      head: "b".repeat(64),
    },
    discoveryGeneration: 1,
  };
  const grant: CoDriveGrant = {
    v: 3,
    generation: 1,
    active: true,
    recipient: "github:bob",
    contextDigest: "c".repeat(64),
    readyPin: source.pin,
    readyUntil: 9999999999999,
    pending: "00000000-0000-4000-8000-000000000001",
    executor: {
      instanceId: source.instanceId,
      nativeSessionId: source.nativeSessionId,
      bindingRevision: 1,
      host: "Owner host",
      provider: "opencode",
      modelProvider: "fixture",
      modelId: "model",
      modelVariant: null,
      account: "owner-host-configured",
      policyDigest: createHash("sha256").update("null").digest("hex"),
    },
  };
  let operation: CoDriveSend | null = {
    v: 3,
    id: grant.pending!,
    actor: "github:bob",
    generation: 1,
    contextDigest: grant.contextDigest,
    expectedPin: source.pin,
    text: "A synthetic recipient question",
    digest: "d".repeat(64),
    phase: "queued",
    admissionId: null,
    entry: null,
  };
  const native = {
    info: { id: source.nativeSessionId, location: { directory: home } },
    messages: [] as Array<{
      id: string;
      type: string;
      text: string;
      metadata: { paseoClientMessageId: string };
    }>,
  };
  const fault = { nativeReply: false, admissionReply: false, revoked: false };
  const view = () => ({
    sourceId: source.sourceId,
    ownerId: "github:alice",
    pin: source.pin,
    control: grant,
    operation,
    ready: true,
    surface: "send-text",
  });
  const calls = { native: 0, admissions: 0, recorded: 0 };
  const hooks = {
    source: async () => structuredClone(source),
    call: vi.fn(async (_source: ControlSource, request?: Record<string, unknown>) => {
      if (!request) return structuredClone(view());
      if (request.action === "announce") return { control: grant };
      if (request.action === "cancel") {
        if (operation) operation.phase = "canceled";
        grant.pending = null;
        return { operation };
      }
      if (request.action === "admit") {
        if (!grant.active) throw new Error("not-found");
        calls.admissions++;
        if (!operation || operation.phase !== "queued")
          return { operation, executionGranted: false };
        operation.phase = "admitted";
        operation.admissionId = String(request.admissionId);
        if (fault.admissionReply) throw new Error("synthetic-lost-admission-reply");
        return { operation: structuredClone(operation), executionGranted: true };
      }
      if (request.action === "record") {
        calls.recorded++;
        if (operation) {
          operation.phase = "recorded";
          operation.entry = { pin: source.pin, seq: 1 };
        }
        grant.pending = null;
        return { operation };
      }
      throw new Error("unsupported control surface");
    }),
    verify: vi.fn(async () => {
      if (fault.revoked) grant.active = false;
    }),
    capture: async () => structuredClone(source),
    native: async () => structuredClone(native),
    busy: () => false,
    disable: vi.fn(async () => {}),
    run: vi.fn(async (_source: ControlSource, input: CoDriveSend, admit: () => Promise<void>) => {
      await admit();
      calls.native++;
      native.messages.push({
        id: "msg_recipient",
        type: "user",
        text: input.text,
        metadata: { paseoClientMessageId: `co-drive:${input.id}` },
      });
      if (fault.nativeReply) throw new Error("synthetic-lost-native-reply");
    }),
  };
  return {
    home,
    source,
    grant,
    fault,
    hooks,
    calls,
    native,
    driver: () => new CoDriveDriver(home, hooks),
    clearPending: () => {
      operation = null;
      grant.pending = null;
    },
  };
}

test("co-drive worker uses the original executor and authenticated actor without a new session", async () => {
  const f = await fixture();
  await f.driver().tick("agent");
  expect(f.calls).toEqual({ native: 1, admissions: 1, recorded: 1 });
  expect(f.hooks.run.mock.calls[0]![0].nativeSessionId).toBe("ses_original");
  expect(f.hooks.run.mock.calls[0]![1].actor).toBe("github:bob");
  expect(f.source.pin.sourceId).toBe("a".repeat(64));
  f.clearPending();
  await f.driver().tick("agent");
  expect(f.calls.native).toBe(1);
});

test("lost native reply recovers the existing input after reconstruction without sending twice", async () => {
  const f = await fixture();
  f.fault.nativeReply = true;
  await expect(f.driver().tick("agent")).rejects.toThrow("synthetic-lost-native-reply");
  f.fault.nativeReply = false;
  await f.driver().tick("agent");
  expect(f.calls.native).toBe(1);
  expect(f.calls.admissions).toBe(1);
  expect(f.calls.recorded).toBe(1);
});

test("lost admission reply with no native proof stays unknown, never becomes another execution", async () => {
  const f = await fixture();
  f.fault.admissionReply = true;
  await expect(f.driver().tick("agent")).rejects.toThrow("synthetic-lost-admission-reply");
  await expect(f.driver().tick("agent")).rejects.toThrow("agent_request_outcome_unknown");
  expect(f.calls.native).toBe(0);
  expect(f.calls.admissions).toBe(1);
});

test("revocation between offer and admission cancels only queued work", async () => {
  const f = await fixture();
  f.fault.revoked = true;
  await expect(f.driver().tick("agent")).rejects.toThrow("chi-control-context-changed");
  expect(f.calls.native).toBe(0);
  expect(f.calls.admissions).toBe(0);
  expect(f.hooks.call.mock.calls.some(([, request]) => request?.action === "cancel")).toBe(true);
});

test("reading readiness and a forged owner label do not create native work", async () => {
  const f = await fixture();
  f.clearPending();
  await f.driver().tick("agent");
  expect(f.calls.native).toBe(0);
  f.source.actor = "github:bob";
  await expect(f.driver().tick("agent")).rejects.toThrow("chi-control-owner-required");
  expect(f.calls.native).toBe(0);
});
