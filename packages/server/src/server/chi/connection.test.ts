import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { NativeRuntime } from "@henkaku-center/chi-native/continuation";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { ChiConnection, type ChiAuthority } from "./connection.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "chi-owner-")));
  homes.push(home);
  execFileSync("git", ["init", "--quiet", home]);
  execFileSync("git", [
    "-C",
    home,
    "remote",
    "add",
    "origin",
    "https://github.com/fixture/repo.git",
  ]);
  const input = {
    repo: "github:fixture/repo",
    sourceId: "a".repeat(64),
    snapshotId: "b".repeat(64),
    cwd: home,
    workspaceId: "workspace",
    requestId: "request",
  };
  const nativeFork = {
    sessionID: "ses_source",
    boundary: { type: "through", messageID: "msg_source" },
  };
  const payload = { text: "fixture" };
  const transfer = {
    info: { id: "ses_fork", location: { directory: home }, fork: nativeFork },
    messages: [{ id: "msg_fork", ...payload }],
  };
  const runtime: NativeRuntime = {
    identity: "http://fixture-runtime",
    info: vi.fn(),
    schema: vi.fn(),
    get: vi.fn(),
    export: vi.fn(async () => structuredClone(transfer)),
    import: vi.fn(),
    fork: vi.fn(),
  };
  const request = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/session") return Response.json({ ok: true, chiUserId: "github:owner" });
    if (path === "/repos") return Response.json({ ok: true, repos: [{ repo: input.repo }] });
    if (path === "/evidence/inspect") return Response.json({ sourceId: input.sourceId });
    throw new Error(`unexpected request: ${path}`);
  });
  const authority: ChiAuthority = {
    endpoint: "https://chi.invalid",
    request,
    login: async () => ({ sessionToken: "fixture", chiUserId: "github:owner" }),
  };
  const receipt = {
    version: 1,
    kind: "native-fork-continuation",
    status: "ready",
    turnStarted: false,
    source: { repo: input.repo, sourceId: input.sourceId, snapshotId: input.snapshotId },
    destination: { origin: "server:opencode", workspace: home, sessionId: "ses_fork", nativeFork },
    owner: { actor: "github:owner", workspaceId: input.workspaceId, endpoint: authority.endpoint },
    messageMapping: [
      {
        sourceEntryId: "msg_source",
        destinationEntryId: "msg_fork",
        payloadWithoutIdSHA256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      },
    ],
  };
  await mkdir(join(home, "chi", "receipts"), { recursive: true });
  const receiptPath = join(home, "chi", "receipts", "request.json");
  await writeFile(receiptPath, JSON.stringify(receipt));
  const agents: ManagedAgent[] = [];
  const manager = {
    listAgents: () => agents,
    getAgent: (id: string) => agents.find((agent) => agent.id === id),
    withNativeRuntime: async <T>(_id: string | null, fn: (runtime: NativeRuntime) => Promise<T>) =>
      fn(runtime),
    updateAgentMetadata: vi.fn(async (id: string, patch: { labels: Record<string, string> }) => {
      Object.assign(agents.find((agent) => agent.id === id)!.labels, patch.labels);
    }),
  } as unknown as AgentManager;
  const registration = {
    find: vi.fn(async () => agents[0] ?? null),
    register: vi.fn(async (sessionId: string, labels: Record<string, string>) => {
      const agent = {
        id: "paseo-agent",
        provider: "opencode",
        cwd: home,
        workspaceId: input.workspaceId,
        labels,
        lifecycle: "idle",
        finalizedForegroundTurnIds: new Set<string>(),
        persistence: { sessionId },
      } as ManagedAgent;
      agents.push(agent);
      return agent;
    }),
  };
  const restart = () => new ChiConnection(manager, { home, serverId: "server", authority });
  return {
    home,
    input,
    runtime,
    transfer,
    authority,
    receipt,
    receiptPath,
    agents,
    manager,
    registration,
    restart,
  };
}

describe("Chi owner recovery", () => {
  it("serializes receipt registration and reauthorizes an existing result before returning it", async () => {
    const f = await fixture();
    const owner = f.restart();
    const first = owner.continue(f.input, f.registration);
    await expect(owner.continue(f.input, f.registration)).rejects.toThrow(
      "chi-continuation-in-progress",
    );
    await first;
    vi.mocked(f.authority.request).mockImplementation(
      async () => new Response("private body", { status: 403 }),
    );
    await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow("chi-http-403");
    expect(f.registration.register).toHaveBeenCalledTimes(1);
    expect(f.runtime.fork).not.toHaveBeenCalled();
  });

  it("registers a ready fork after a crash, then returns the advanced registered agent after restart/lost reply", async () => {
    const f = await fixture();
    f.runtime.identity = "http://new-process-after-crash";
    const first = await f.restart().continue(f.input, f.registration);
    expect(first.snapshot.id).toBe("paseo-agent");
    f.transfer.messages.push({ id: "msg_new", text: "later work" });
    f.runtime.identity = "http://restarted-runtime-port";
    const recovered = await f.restart().continue(f.input, f.registration);
    expect(recovered.snapshot.id).toBe(first.snapshot.id);
    expect(f.registration.register).toHaveBeenCalledTimes(1);
    expect(f.runtime.export).toHaveBeenCalledTimes(1);
    expect(f.runtime.fork).not.toHaveBeenCalled();
    expect(f.runtime.import).not.toHaveBeenCalled();
  });

  it("rejects altered unregistered exports and mismatching registration labels", async () => {
    const f = await fixture();
    f.transfer.messages[0].text = "changed";
    await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow(
      "fork-history-mismatch",
    );
    expect(f.registration.register).not.toHaveBeenCalled();
    await f.registration.register("ses_fork", {});
    await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow(
      "registration-mismatch",
    );
  });

  it.each(["importing", "forking", "verifying"])(
    "keeps %s ambiguous mutations blocked across restart",
    async (failedAt) => {
      const f = await fixture();
      await writeFile(f.receiptPath, JSON.stringify({ ...f.receipt, status: "failed", failedAt }));
      await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow(
        "recovery-required",
      );
      expect(f.registration.register).not.toHaveBeenCalled();
      expect(f.runtime.fork).not.toHaveBeenCalled();
    },
  );

  it("reports a proven pre-mutation failure as a new explicit attempt, without replay", async () => {
    const f = await fixture();
    await writeFile(
      f.receiptPath,
      JSON.stringify({
        ...f.receipt,
        destination: { origin: "server:opencode", workspace: f.home },
        status: "failed",
        failedAt: "preparing",
      }),
    );
    await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow(
      "pre-mutation-failed-start-new-attempt",
    );
    expect(f.runtime.fork).not.toHaveBeenCalled();
  });

  it("rejects a host workspace identity change with the same request ID", async () => {
    const f = await fixture();
    await expect(
      f.restart().continue({ ...f.input, workspaceId: "other" }, f.registration),
    ).rejects.toThrow("receipt-identity-mismatch");
    expect(f.registration.register).not.toHaveBeenCalled();
    const otherOwner = new ChiConnection(f.manager, {
      home: f.home,
      serverId: "other",
      authority: f.authority,
    });
    await expect(otherOwner.continue(f.input, f.registration)).rejects.toThrow(
      "receipt-identity-mismatch",
    );
  });

  it("rejects capture when a whole new turn replaces an entry in the full 50-ID set during export", async () => {
    const f = await fixture();
    const agent = await f.registration.register("ses_fork", {
      "chi.native": JSON.stringify({
        repo: f.input.repo,
        actor: "github:owner",
        sourceId: f.input.sourceId,
        head: f.input.snapshotId,
        error: null,
      }),
    });
    for (let i = 0; i < 50; i++) agent.finalizedForegroundTurnIds.add(`turn-${i}`);
    vi.mocked(f.runtime.export).mockImplementationOnce(async () => {
      agent.finalizedForegroundTurnIds.delete("turn-0");
      agent.finalizedForegroundTurnIds.add("turn-50");
      return f.transfer;
    });
    await expect(f.restart().capture(agent.id)).rejects.toThrow("chi-session-busy");
    expect(JSON.parse(agent.labels["chi.native"]!)).toMatchObject({
      head: f.input.snapshotId,
      error: "chi-session-busy",
    });
    expect(
      vi
        .mocked(f.authority.request)
        .mock.calls.every(([, init]) => !init?.method || init.method === "GET"),
    ).toBe(true);
  });
});
