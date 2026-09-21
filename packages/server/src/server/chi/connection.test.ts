import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { NativeRuntime } from "@henkaku-center/chi-native/continuation";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { ChiConnection, type ChiAuthority } from "./connection.js";

const homes: string[] = [];
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
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
  const payload = { text: "fixture", type: "text" };
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
  await mkdir(join(home, "chi", "receipts"), { recursive: true, mode: 0o700 });
  const receiptPath = join(home, "chi", "receipts", "request.json");
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  const agents: ManagedAgent[] = [];
  const manager = {
    listAgents: () => structuredClone(agents),
    getAgent: (id: string) => structuredClone(agents.find((agent) => agent.id === id)),
    isChiAgentBusy: vi.fn(() => false),
    withChiAdmission: async <T>(_id: string, action: () => Promise<T>) => action(),
    archiveAgent: vi.fn(async () => undefined),
    withNativeRuntime: async <T>(_id: string | null, fn: (runtime: NativeRuntime) => Promise<T>) =>
      fn(runtime),
    updateAgentMetadata: vi.fn(async (id: string, patch: { labels: Record<string, string> }) => {
      const i = agents.findIndex((agent) => agent.id === id);
      agents[i] = { ...agents[i]!, labels: { ...agents[i]!.labels, ...patch.labels } };
    }),
    updateAgentLabel: vi.fn(
      async (id: string, key: string, update: (current: string | undefined) => string) => {
        const i = agents.findIndex((agent) => agent.id === id);
        const value = update(agents[i]!.labels[key]);
        agents[i] = { ...agents[i]!, labels: { ...agents[i]!.labels, [key]: value } };
        return value;
      },
    ),
  } as unknown as AgentManager;
  const registration = {
    find: vi.fn(async () => structuredClone(agents[0] ?? null)),
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
      return structuredClone(agent);
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
    f.transfer.messages.push({ id: "msg_new", type: "text", text: "later work" });
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
    for (let i = 0; i < 50; i++) f.agents[0]!.finalizedForegroundTurnIds.add(`turn-${i}`);
    vi.mocked(f.runtime.export).mockImplementationOnce(async () => {
      f.agents[0]!.finalizedForegroundTurnIds.delete("turn-0");
      f.agents[0]!.finalizedForegroundTurnIds.add("turn-50");
      return f.transfer;
    });
    await expect(f.restart().capture(agent.id)).rejects.toThrow("chi-session-busy");
    expect(JSON.parse(f.manager.getAgent(agent.id)!.labels["chi.native"]!)).toMatchObject({
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

async function canonicalFixture() {
  const f = await fixture();
  const canonical = { conversationId: "conversation", transferId: "transfer" };
  const input = { ...f.input, canonical };
  const key = createHash("sha256")
    .update(JSON.stringify([input.repo, canonical.conversationId, canonical.transferId]))
    .digest("hex");
  const path = join(f.home, "chi", "receipts", `${key}.json`);
  const journalPath = join(f.home, "chi", "receipts", `${key}.claim.json`);
  const destination = {
    instanceId: "server:opencode",
    workspace: { hostId: "server", path: f.home },
  };
  const claim = {
    id: canonical.conversationId,
    revision: 2,
    transferId: canonical.transferId,
    claimId: "claim",
    destination,
  };
  const identity = {
    repo: input.repo,
    sourceId: input.sourceId,
    snapshotId: input.snapshotId,
    endpoint: f.authority.endpoint,
    actor: "github:owner",
    workspaceId: input.workspaceId,
    destination,
    canonical,
  };
  const transfer = {
    id: "transfer",
    sourceId: input.sourceId,
    snapshotId: input.snapshotId,
    destination,
    phase: "reserved" as "reserved" | "claimed" | "published" | "canceled",
    claim: undefined as undefined | { id: string },
    publication: undefined as
      | undefined
      | {
          destination: {
            sourceId: string;
            snapshotId: string;
            instanceId: string;
            nativeSessionId: string;
          };
        },
  };
  const conversation = {
    id: "conversation",
    repo: input.repo,
    ownerId: "github:owner",
    revision: 2,
    current: {
      sourceId: input.sourceId,
      instanceId: "source:opencode",
      nativeSessionId: "ses_source",
    },
    pending: "transfer" as string | null,
    transfers: [transfer],
  };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const base = f.authority.request;
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    if (!pathname.startsWith("/conversations")) return base(url, init);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path: pathname, body });
    let executionGranted: boolean | undefined;
    if (pathname.endsWith("/claim")) {
      executionGranted = transfer.phase === "reserved";
      transfer.phase = "claimed";
      transfer.claim = { id: String(body.claimId) };
      conversation.revision = 3;
    }
    if (pathname.endsWith("/publish")) {
      transfer.phase = "published";
      transfer.publication = {
        destination: {
          sourceId: "c".repeat(64),
          snapshotId: "d".repeat(64),
          instanceId: "server:opencode",
          nativeSessionId: "ses_fork",
        },
      };
      if (conversation.pending) conversation.current = transfer.publication.destination;
      conversation.pending = null;
      conversation.revision = 4;
    }
    return Response.json({ ok: true, conversation, transfer, executionGranted });
  });
  f.authority.request = request;
  const ready = async () => {
    transfer.phase = "claimed";
    transfer.claim = { id: "claim" };
    conversation.revision = 3;
    await writeFile(path, JSON.stringify(f.receipt), { mode: 0o600 });
    await writeFile(journalPath, JSON.stringify({ identity, claim }), { mode: 0o600 });
  };
  return {
    ...f,
    input,
    path,
    journalPath,
    identity,
    claim,
    conversation,
    transfer,
    requests,
    request,
    ready,
  };
}

describe("canonical Chi coordination", () => {
  it("syncs an already-visible publication before HTTP, even while its writer is paused before directory sync", async () => {
    const f = await canonicalFixture();
    await f.ready();
    const linked = barrier(),
      releaseWriter = barrier(),
      readerSync = barrier(),
      failReader = barrier();
    const open = fs.open.bind(fs);
    let syncs = 0;
    async function syncWithBarrier(sync: () => Promise<void>) {
      const attempt = ++syncs;
      if (attempt === 1) {
        linked.resolve();
        await releaseWriter.promise;
      }
      if (attempt === 2) {
        readerSync.resolve();
        await failReader.promise;
        throw new Error("directory sync failed");
      }
      return sync();
    }
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === join(f.home, "chi", "receipts") && args[1] === "r") {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(syncWithBarrier.bind(null, sync));
      }
      return handle;
    });
    let writer: Promise<unknown> | undefined;
    try {
      writer = f.restart().continue(f.input, f.registration);
      await linked.promise;
      const publicationPath = f.journalPath.replace(".claim.json", ".publication.json");
      const winner = JSON.parse(await readFile(publicationPath, "utf8"));
      const reader = f.restart().continue({ ...f.input, requestId: "reader" }, f.registration);
      const failed = expect(reader).rejects.toThrow("directory sync failed");
      await readerSync.promise;
      expect(f.requests.filter((r) => r.path.endsWith("/publish"))).toHaveLength(0);
      failReader.resolve();
      await failed;
      expect(f.requests.filter((r) => r.path.endsWith("/publish"))).toHaveLength(0);
      // A new reader can establish durability itself without waiting on the
      // original process, and must submit the immutable winning request.
      await f.restart().continue({ ...f.input, requestId: "durable-reader" }, f.registration);
      expect(syncs).toBe(3);
      expect(f.requests.filter((r) => r.path.endsWith("/publish")).map((r) => r.body)).toEqual([
        winner,
      ]);
      releaseWriter.resolve();
      await writer;
      expect(f.requests.filter((r) => r.path.endsWith("/publish")).map((r) => r.body)).toEqual([
        winner,
        winner,
      ]);
    } finally {
      releaseWriter.resolve();
      failReader.resolve();
      await writer?.catch(() => undefined);
      spy.mockRestore();
    }
  });

  it("quarantines a ready unregistered fork across restart and permits only its verified recovery registration", async () => {
    const f = await canonicalFixture();
    await f.ready();
    const owner = f.restart();
    const selection = {
      provider: "opencode",
      providerHandleId: "ses_fork",
      cwd: f.home,
      workspaceId: f.input.workspaceId,
    };
    expect(await owner.quarantinedSessions()).toEqual([
      { sessionId: "ses_fork", cwd: f.home, kind: "fork" },
    ]);
    await expect(f.restart().assertImportAllowed(selection)).rejects.toThrow("recovery-required");
    let permit: object | undefined;
    const register = f.registration.register;
    const result = await owner.continue(f.input, {
      find: f.registration.find,
      register: async (sessionId, labels, chiRegistration) => {
        permit = chiRegistration;
        await expect(
          owner.assertImportAllowed({ ...selection, labels, chiRegistration }),
        ).resolves.toBeUndefined();
        await expect(
          owner.assertImportAllowed({ ...selection, labels: {}, chiRegistration }),
        ).rejects.toThrow("recovery-required");
        await expect(
          f.restart().assertImportAllowed({ ...selection, labels, chiRegistration }),
        ).rejects.toThrow("recovery-required");
        return register(sessionId, labels);
      },
    });
    await expect(
      owner.assertImportAllowed({
        ...selection,
        labels: result.snapshot.labels,
        chiRegistration: permit,
      }),
    ).rejects.toThrow("recovery-required");
    await f.restart().continue(f.input, f.registration);
    expect(register).toHaveBeenCalledTimes(1);
    expect(f.runtime.import).not.toHaveBeenCalled();
    expect(f.runtime.fork).not.toHaveBeenCalled();
  });

  it("keeps the first publication immutable across independent managers when a delayed export sees a later turn", async () => {
    const f = await canonicalFixture();
    await f.ready();
    const aExport = barrier(),
      bExport = barrier(),
      releaseA = barrier(),
      releaseB = barrier();
    const native = (await f.runtime.export("ses_fork")) as {
      messages: { id: string; type: string; text: string }[];
    };
    let exports = 0;
    f.runtime.export = vi.fn(async () => {
      if (++exports === 2) {
        aExport.resolve();
        await releaseA.promise;
      } else if (exports === 3) {
        bExport.resolve();
        await releaseB.promise;
      }
      return structuredClone(native);
    });
    const a = f.restart().continue(f.input, f.registration);
    await aExport.promise;
    // Separate process-shaped manager: no shared labels, queues or connection sets.
    let bAgent = structuredClone(f.agents[0]!);
    const manager = {
      ...f.manager,
      getAgent: () => structuredClone(bAgent),
      listAgents: () => [structuredClone(bAgent)],
      updateAgentLabel: async (
        _id: string,
        key: string,
        update: (current: string | undefined) => string,
      ) => {
        const value = update(bAgent.labels[key]);
        bAgent = { ...bAgent, labels: { ...bAgent.labels, [key]: value } };
        return value;
      },
    } as unknown as AgentManager;
    const ownerB = new ChiConnection(manager, {
      home: f.home,
      serverId: "server",
      authority: f.authority,
    });
    const b = ownerB.continue(f.input, {
      find: async () => structuredClone(bAgent),
      register: f.registration.register,
    });
    await bExport.promise;
    releaseA.resolve();
    await a;
    const publicationPath = f.journalPath.replace(".claim.json", ".publication.json");
    const original = await readFile(publicationPath, "utf8");
    await f.restart().withPromptAdmission("paseo-agent", async () => {
      native.messages.push({ id: "msg_later", type: "text", text: "later turn" });
    });
    releaseB.resolve();
    await b;
    expect(await readFile(publicationPath, "utf8")).toBe(original);
    await ownerB.continue(
      { ...f.input, requestId: "recover" },
      { find: async () => structuredClone(bAgent), register: f.registration.register },
    );
    expect(f.requests.filter((r) => r.path.endsWith("/publish")).map((r) => r.body)).toEqual([
      JSON.parse(original),
      JSON.parse(original),
      JSON.parse(original),
    ]);
    expect(f.registration.register).toHaveBeenCalledTimes(1);
    expect(f.runtime.fork).not.toHaveBeenCalled();
  });

  it("merges a delayed Share capture with preparation using replaced snapshot labels", async () => {
    const f = await fixture();
    const sourceId = createHash("sha256")
      .update(JSON.stringify(["opencode-v2", "server:opencode", "ses_fork"]))
      .digest("hex");
    const agent = await f.registration.register("ses_fork", {
      "chi.native": JSON.stringify({
        repo: f.input.repo,
        actor: "github:owner",
        sourceId,
        head: f.input.snapshotId,
        error: null,
      }),
    });
    const adoption = barrier(),
      releaseAdoption = barrier(),
      capture = barrier(),
      releaseCapture = barrier();
    const destination = {
      instanceId: "target:opencode",
      workspace: { hostId: "target", path: "/target" },
    };
    const base = f.authority.request;
    let captures = 0,
      id = "";
    f.authority.request = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/evidence") {
        if (++captures === 2) {
          capture.resolve();
          await releaseCapture.promise;
        }
        return Response.json({ sourceId, head: "f".repeat(64) });
      }
      if (!path.startsWith("/conversations")) return base(url, init);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path === "/conversations" && init?.method === "POST") {
        id = body.id;
        adoption.resolve();
        await releaseAdoption.promise;
      }
      const conversation = {
        id,
        repo: f.input.repo,
        ownerId: "github:owner",
        revision: 1,
        current: { sourceId, instanceId: "server:opencode", nativeSessionId: "ses_fork" },
        pending: null,
        transfers: [],
      };
      if (path.endsWith("/reserve"))
        return Response.json({
          ok: true,
          conversation,
          transfer: {
            id: "move",
            sourceId,
            snapshotId: "f".repeat(64),
            destination,
            phase: "reserved",
          },
        });
      return Response.json({ ok: true, conversation });
    };
    const prepare = f.restart().prepare(agent.id, "move", destination);
    await adoption.promise;
    const share = f.restart().share(agent.id);
    await capture.promise;
    releaseAdoption.resolve();
    await prepare;
    const before = JSON.parse(f.manager.getAgent(agent.id)!.labels["chi.native"]!);
    releaseCapture.resolve();
    await share;
    expect(JSON.parse(f.manager.getAgent(agent.id)!.labels["chi.native"]!)).toEqual(before);
    expect(before).toMatchObject({
      blocked: true,
      conversationId: id,
      reserve: { transferId: "move" },
    });
    expect(agent.labels).not.toEqual(f.manager.getAgent(agent.id)!.labels);
  });

  it.each([false, true])(
    "retains the exact cancellation request after completion and lost reply=%s",
    async (lostReply) => {
      const f = await canonicalFixture();
      const agent = await f.registration.register("ses_source", {
        "chi.native": JSON.stringify({
          repo: f.input.repo,
          actor: "github:owner",
          sourceId: f.input.sourceId,
          head: f.input.snapshotId,
          error: null,
          conversationId: "conversation",
          blocked: true,
          reserve: {
            id: "conversation",
            revision: 1,
            transferId: "transfer",
            sourceId: f.input.sourceId,
            snapshotId: f.input.snapshotId,
            destination: f.claim.destination,
          },
        }),
      });
      const base = f.authority.request;
      const requests: unknown[] = [];
      f.authority.request = async (url, init) => {
        if (!new URL(String(url)).pathname.endsWith("/cancel")) return base(url, init);
        requests.push(JSON.parse(String(init?.body)));
        f.conversation.pending = null;
        f.conversation.revision = 3;
        f.transfer.phase = "canceled";
        if (lostReply && requests.length === 1) throw new Error("lost cancel reply");
        return Response.json({ ok: true, conversation: f.conversation, transfer: f.transfer });
      };
      if (lostReply)
        await expect(f.restart().reconcile(agent.id, true)).rejects.toThrow("lost cancel reply");
      else await f.restart().reconcile(agent.id, true);
      await f.restart().reconcile(agent.id, true);
      const association = JSON.parse(f.manager.getAgent(agent.id)!.labels["chi.native"]!);
      expect(requests).toEqual([
        { id: "conversation", revision: 2, transferId: "transfer" },
        { id: "conversation", revision: 2, transferId: "transfer" },
      ]);
      expect(association.cancel).toEqual(requests[0]);
      expect(association.blocked).toBe(false);
    },
  );

  it("persists source admission closure before capture and retries the original reservation after a lost reply", async () => {
    const f = await fixture();
    const sourceId = createHash("sha256")
      .update(JSON.stringify(["opencode-v2", "server:opencode", "ses_fork"]))
      .digest("hex");
    const agent = await f.registration.register("ses_fork", {
      "chi.native": JSON.stringify({
        repo: f.input.repo,
        actor: "github:owner",
        sourceId,
        head: f.input.snapshotId,
        error: null,
      }),
    });
    const destination = {
      instanceId: "target:opencode",
      workspace: { hostId: "target", path: "/target" },
    };
    const base = f.authority.request;
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    let failReserve = true;
    let id = "";
    f.authority.request = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/evidence") {
        expect(JSON.parse(f.manager.getAgent(agent.id)!.labels["chi.native"]!).blocked).toBe(true);
        return Response.json({ sourceId, head: "f".repeat(64) });
      }
      if (!path.startsWith("/conversations")) return base(url, init);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (init?.method === "POST") posts.push({ path, body });
      if (path === "/conversations" && init?.method === "POST") {
        expect(JSON.parse(f.manager.getAgent(agent.id)!.labels["chi.native"]!).adopt).toEqual(body);
        id = body.id;
      }
      const conversation = {
        id,
        repo: f.input.repo,
        ownerId: "github:owner",
        revision: 1,
        current: { sourceId, instanceId: "server:opencode", nativeSessionId: "ses_fork" },
        pending: null,
        transfers: [],
      };
      if (path.endsWith("/reserve")) {
        expect(JSON.parse(f.manager.getAgent(agent.id)!.labels["chi.native"]!).reserve).toEqual(
          body,
        );
        if (failReserve) throw new Error("lost reserve reply");
        return Response.json({
          ok: true,
          conversation: { ...conversation, revision: 2, pending: "move" },
          transfer: {
            id: "move",
            sourceId,
            snapshotId: "f".repeat(64),
            destination,
            phase: "reserved",
          },
        });
      }
      return Response.json({ ok: true, conversation });
    };
    await expect(f.restart().prepare(agent.id, "move", destination)).rejects.toThrow(
      "lost reserve reply",
    );
    await expect(f.restart().withPromptAdmission(agent.id, async () => "turn")).rejects.toThrow(
      "pending",
    );
    failReserve = false;
    const result = await f.restart().prepare(agent.id, "move", destination);
    expect(result.transfer?.snapshotId).toBe("f".repeat(64));
    expect(posts.filter((p) => p.path.endsWith("/reserve")).map((p) => p.body)).toEqual([
      JSON.parse(f.manager.getAgent(agent.id)!.labels["chi.native"]!).reserve,
      JSON.parse(f.manager.getAgent(agent.id)!.labels["chi.native"]!).reserve,
    ]);
    expect(f.runtime.export).toHaveBeenCalledTimes(1);
  });

  it("source-head divergence rejects publication and keeps the registered fork blocked", async () => {
    const f = await canonicalFixture();
    await f.ready();
    const base = f.authority.request;
    f.authority.request = (url, init) =>
      new URL(String(url)).pathname.endsWith("/publish")
        ? Promise.resolve(new Response("private source-advanced detail", { status: 409 }))
        : base(url, init);
    await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow(
      "chi-conversation-http-409",
    );
    expect(JSON.parse(f.agents[0]!.labels["chi.native"]!).blocked).toBe(true);
    await expect(f.restart().capture("paseo-agent")).rejects.toThrow(
      "chi-conversation-publication-pending",
    );
    expect(f.runtime.export).toHaveBeenCalledTimes(2);
    await expect(
      f.restart().withPromptAdmission("paseo-agent", async () => "turn"),
    ).rejects.toThrow("pending");
    await expect(
      f.restart().continue({ ...f.input, requestId: "retry" }, f.registration),
    ).rejects.toThrow("chi-conversation-http-409");
    expect(f.registration.register).toHaveBeenCalledTimes(1);
    expect(f.runtime.fork).not.toHaveBeenCalled();
  });

  it("recovers a ready fork once by transfer identity, persists publication, and returns advanced registered work", async () => {
    const f = await canonicalFixture();
    await f.ready();
    const first = await f.restart().continue(f.input, f.registration);
    expect(JSON.parse(first.snapshot.labels["chi.native"]!)).toMatchObject({
      conversationId: "conversation",
      sourceId: "c".repeat(64),
      blocked: false,
    });
    const publication = JSON.parse(
      await readFile(f.journalPath.replace(".claim.json", ".publication.json"), "utf8"),
    );
    f.transfer.phase = "published";
    f.agents[0]!.labels["chi.native"] = JSON.stringify({
      ...JSON.parse(f.agents[0]!.labels["chi.native"]!),
      head: "e".repeat(64),
    });
    f.runtime.export = vi.fn(async () => {
      throw new Error("advanced runtime must not be re-exported");
    });
    const recovered = await f
      .restart()
      .continue({ ...f.input, requestId: "new-client-request" }, f.registration);
    expect(recovered.snapshot.id).toBe(first.snapshot.id);
    expect(JSON.parse(recovered.snapshot.labels["chi.native"]!).head).toBe("e".repeat(64));
    expect(f.requests.filter((r) => r.path.endsWith("/publish")).map((r) => r.body)).toEqual([
      publication,
      publication,
    ]);
    expect(f.registration.register).toHaveBeenCalledTimes(1);
    expect(f.runtime.fork).not.toHaveBeenCalled();
  });

  it("lost claim reply blocks native replay even with a new client request id", async () => {
    const f = await canonicalFixture();
    const base = f.authority.request;
    f.authority.request = async (url, init) => {
      const response = await base(url, init);
      if (new URL(String(url)).pathname.endsWith("/claim")) throw new Error("lost reply");
      return response;
    };
    await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow("lost reply");
    f.authority.request = base;
    await expect(
      f.restart().continue({ ...f.input, requestId: "another-request" }, f.registration),
    ).rejects.toThrow("recovery-required");
    expect(f.runtime.fork).not.toHaveBeenCalled();
    expect(f.runtime.import).not.toHaveBeenCalled();
    expect(f.registration.register).not.toHaveBeenCalled();
  });

  it("missing claim receipt and ambiguous native receipts never recreate a claimed fork", async () => {
    const f = await canonicalFixture();
    await f.ready();
    await rm(f.journalPath);
    await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow(
      "recovery-required",
    );
    await f.ready();
    await writeFile(f.path, JSON.stringify({ ...f.receipt, status: "forking" }));
    await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow(
      "recovery-required",
    );
    expect(f.runtime.fork).not.toHaveBeenCalled();
  });

  it("publication lost reply retries identical capture without another registration or native operation", async () => {
    const f = await canonicalFixture();
    await f.ready();
    const base = f.authority.request;
    f.authority.request = async (url, init) => {
      const response = await base(url, init);
      if (new URL(String(url)).pathname.endsWith("/publish")) throw new Error("lost publish reply");
      return response;
    };
    await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow(
      "lost publish reply",
    );
    expect(JSON.parse(f.agents[0]!.labels["chi.native"]!).blocked).toBe(true);
    f.authority.request = base;
    await f.restart().continue(f.input, f.registration);
    expect(f.registration.register).toHaveBeenCalledTimes(1);
    const writes = f.requests.filter((r) => r.path.endsWith("/publish"));
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
  });

  it("does not reactivate an old completed destination after the conversation moved again", async () => {
    const f = await canonicalFixture();
    await f.ready();
    await f.restart().continue(f.input, f.registration);
    f.conversation.current = {
      sourceId: "e".repeat(64),
      instanceId: "third:opencode",
      nativeSessionId: "ses_third",
    };
    await f.restart().continue(f.input, f.registration);
    expect(JSON.parse(f.agents[0]!.labels["chi.native"]!).blocked).toBe(true);
    expect(f.manager.archiveAgent).toHaveBeenCalledWith("paseo-agent");
    await expect(
      f.restart().withPromptAdmission("paseo-agent", async () => "turn"),
    ).rejects.toThrow("pending");
  });

  it("serializes concurrent continuation callers using the transfer, regardless of request id", async () => {
    const f = await canonicalFixture();
    await f.ready();
    const owner = f.restart();
    const first = owner.continue(f.input, f.registration);
    await expect(
      owner.continue({ ...f.input, requestId: "different" }, f.registration),
    ).rejects.toThrow("in-progress");
    await first;
    expect(f.registration.register).toHaveBeenCalledTimes(1);
  });

  it("fresh prompt authorization fails closed for pending, stale, and offline conversations after restart", async () => {
    const f = await canonicalFixture();
    const agent = await f.registration.register("ses_source", {
      "chi.native": JSON.stringify({
        repo: f.input.repo,
        actor: "github:owner",
        sourceId: f.input.sourceId,
        head: f.input.snapshotId,
        error: null,
        conversationId: "conversation",
      }),
    });
    const start = vi.fn(async () => "turn");
    await expect(f.restart().withPromptAdmission(agent.id, start)).rejects.toThrow("pending");
    f.conversation.pending = null;
    expect(await f.restart().withPromptAdmission(agent.id, start)).toBe("turn");
    f.conversation.current.sourceId = "c".repeat(64);
    await expect(f.restart().withPromptAdmission(agent.id, start)).rejects.toThrow("stale");
    f.authority.request = async () => {
      throw new Error("offline");
    };
    await expect(f.restart().withPromptAdmission(agent.id, start)).rejects.toThrow("offline");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("busy preparation refuses capture, and archive failure retains the durable stale block", async () => {
    const f = await canonicalFixture();
    const agent = await f.registration.register("ses_source", {
      "chi.native": JSON.stringify({
        repo: f.input.repo,
        actor: "github:owner",
        sourceId: f.input.sourceId,
        head: f.input.snapshotId,
        error: null,
        conversationId: "conversation",
      }),
    });
    vi.mocked(f.manager.isChiAgentBusy).mockReturnValue(true);
    await expect(
      f.restart().prepare(agent.id, "new-transfer", f.claim.destination),
    ).rejects.toThrow("busy");
    expect(f.runtime.export).not.toHaveBeenCalled();
    f.conversation.current.sourceId = "c".repeat(64);
    f.conversation.pending = null;
    vi.mocked(f.manager.archiveAgent).mockRejectedValue(new Error("close failed"));
    await expect(f.restart().reconcile(agent.id)).rejects.toThrow("close failed");
    expect(JSON.parse(f.manager.getAgent(agent.id)!.labels["chi.native"]!).blocked).toBe(true);
    await expect(f.restart().withPromptAdmission(agent.id, async () => "turn")).rejects.toThrow(
      "pending",
    );
  });
});
