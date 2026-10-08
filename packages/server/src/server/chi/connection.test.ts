import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { NativeRuntime } from "@henkaku-center/chi-native/continuation";
import { appendHead, initialHead } from "@henkaku-center/chi-native/append-codec";
import { z } from "zod";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { ChiConnection, safeChiError, type ChiAuthority } from "./connection.js";
import { createSessionLogin } from "./session-login.js";
import { ParticipantCache } from "./participant-cache.js";
import { supportsAppendCapture } from "./append-capture.js";
import type { MentionIdentity } from "./mentions.js";

const homes: string[] = [];
interface BackendState {
  capabilities: unknown;
  allowed: boolean;
  entries: string[];
  heads: string[];
}
const LEGACY_ENDPOINT = "https://chi-backend-vadmp23swa-an.a.run.app";
function fixtureConfig(endpoint = LEGACY_ENDPOINT) {
  return {
    destinations: { fixture: { name: "Fixture", endpoint } },
    mappings: [
      { repo: "github:fixture/repo", destination: "fixture", audience: "shared" as const },
    ],
  };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  vi.restoreAllMocks();
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
  const payload = { text: "fixture", type: "user", time: { created: 1 } };
  const transfer = {
    info: {
      id: "ses_fork",
      projectID: "fixture",
      title: "fixture",
      location: { directory: home },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    },
    messages: [{ id: "msg_fork", ...payload }],
  };
  const runtime: NativeRuntime = {
    identity: "http://fixture-runtime",
    info: vi.fn(async () => ({ version: "2.0.15-chi.1" })),
    schema: vi.fn(),
    get: vi.fn(),
    export: vi.fn(async () => structuredClone(transfer)),
    import: vi.fn(),
    fork: vi.fn(),
  };
  const backend: BackendState = {
    capabilities: {
      appendLog: { v: 3, deployment: "fixture" },
      handoffs: { v: 3, references: "pin-seq" },
    },
    allowed: true,
    entries: [],
    heads: [],
  };
  const appendBody = z.object({
    v: z.literal(3),
    sourceId: z.string(),
    expected: z.object({ count: z.number(), head: z.string() }),
    entries: z.array(z.string()),
    creation: z.unknown().optional(),
  });
  const serve: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/auth/session")
      return Response.json({
        ok: true,
        chiUserId: "github:owner",
        capabilities: backend.capabilities,
      });
    if (path === "/repos") return Response.json({ ok: true, repos: [{ repo: input.repo }] });
    if (path === "/participants")
      return Response.json({ ok: true, self: "github:owner", participants: [] });
    if (path === "/evidence/inspect") return Response.json({ sourceId: input.sourceId });
    if (path === "/evidence") {
      if (!backend.allowed)
        return Response.json({ ok: false, reason: "not-found" }, { status: 404 });
      const body = appendBody.parse(JSON.parse(String(init?.body)));
      if (!backend.heads.length)
        backend.heads.push(initialHead(JSON.parse(JSON.stringify(body.creation))));
      expect(body.expected.head).toBe(backend.heads[body.expected.count]);
      const end = body.expected.count + body.entries.length;
      const replay = end <= backend.entries.length;
      if (replay) expect(body.entries).toEqual(backend.entries.slice(body.expected.count, end));
      else {
        expect(body.expected.count).toBe(backend.entries.length);
        for (const bytes of body.entries) {
          backend.heads.push(appendHead(backend.heads.at(-1)!, backend.entries.length, bytes));
          backend.entries.push(bytes);
        }
      }
      return Response.json({
        pin: {
          v: 3,
          deployment: "fixture",
          repo: input.repo,
          sourceId: body.sourceId,
          count: end,
          head: backend.heads[end],
        },
        replay,
      });
    }
    throw new Error(`unexpected request: ${path}`);
  };
  const request = vi.fn(serve);
  const authority: ChiAuthority = {
    invalidate: () => undefined,
    endpoint: LEGACY_ENDPOINT,
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
  const scanner = join(home, "scanner.cjs");
  await writeFile(
    scanner,
    `#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);if(args[0]==='version'){console.log('8.30.1');process.exit(0);}const dir=args.at(-1),bytes=fs.readdirSync(dir).reduce((n,f)=>n+fs.statSync(dir+'/'+f).size,0);console.error('INF scanned ~'+bytes+' bytes ('+bytes+' bytes) in 1ms');`,
    { mode: 0o700 },
  );
  const scan = vi.fn(async () => ({ verdict: "clean" as const }));
  const restart = () =>
    new ChiConnection(manager, {
      home,
      serverId: "server",
      authority,
      getChiConfig: () => fixtureConfig(authority.endpoint),
      scanCapture: scan,
      appendScanner: { command: scanner },
    });
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
    backend,
    serve,
    request,
    scan,
    scanner,
  };
}

describe("mention directory cache", () => {
  const identity: MentionIdentity = {
    repo: "github:fixture/repo",
    actor: "github:owner",
    token: "session",
    deployment: "fixture",
    credentialGeneration: "credential",
  };
  const people = [{ ownerId: "github:sava", handle: "sava" }];

  it.each(["repo", "actor", "credentialGeneration"] as const)(
    "discards delayed %s responses and never reuses a former scope",
    async (field) => {
      const cache = new ParticipantCache();
      const gate = barrier();
      const pending = cache.read("workspace", identity, async () => {
        await gate.promise;
        return people;
      });
      const rejection = expect(pending).rejects.toThrow("chi-mention-context-changed");
      const next = { ...identity, [field]: "changed" };
      expect(await cache.read("workspace", next, async () => [])).toEqual([]);
      gate.resolve();
      await rejection;
      const reload = vi.fn(async () => people);
      expect(await cache.read("workspace", identity, reload)).toEqual(people);
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it("isolates workspace and host instances and returns defensive copies", async () => {
    const cache = new ParticipantCache();
    const load = vi.fn(async () => people);
    const first = await cache.read("a", identity, load);
    first[0]!.handle = "edited";
    expect(await cache.read("a", identity, load)).toEqual(people);
    expect(load).toHaveBeenCalledOnce();
    await cache.read("b", identity, load);
    await new ParticipantCache().read("a", identity, load);
    expect(load).toHaveBeenCalledTimes(3);
    cache.clear();
    await cache.read("a", identity, load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("retries failed acquisition rather than retaining a rejected promise", async () => {
    const cache = new ParticipantCache();
    await expect(
      cache.read("workspace", identity, async () => {
        throw new Error("denied");
      }),
    ).rejects.toThrow("denied");
    expect(await cache.read("workspace", identity, async () => people)).toEqual(people);
  });
});

describe("host Chi session cache", () => {
  function session(token: string) {
    return {
      schemaVersion: 1 as const,
      chiUserId: "github:owner",
      sessionToken: token,
      identityProvider: "github",
      repoProvider: "github",
      createdAt: new Date().toISOString(),
    };
  }

  it("coalesces exchange, expires after 60 seconds, and checks the host credential on every access", async () => {
    let token: string | null = "first";
    const read = vi.fn(() => token);
    const exchange = vi.fn(async (value: string) => session(value));
    const auth = createSessionLogin(read, exchange);
    await Promise.all([auth.login(), auth.login(), auth.login()]);
    expect(exchange).toHaveBeenCalledTimes(1);
    const calls = read.mock.calls.length;
    await auth.login();
    expect(read).toHaveBeenCalledTimes(calls + 1);
    token = "second";
    expect((await auth.login()).sessionToken).toBe("second");
    expect(exchange).toHaveBeenCalledTimes(2);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    await auth.login();
    expect(exchange).toHaveBeenCalledTimes(3);
    token = null;
    await expect(auth.login()).rejects.toThrow("chi-github-login-required");
    token = "second";
    await auth.login();
    expect(exchange).toHaveBeenCalledTimes(4);
    auth.invalidate();
    await auth.login();
    expect(exchange).toHaveBeenCalledTimes(5);
  });

  it("rejects old exchanges after credential change or explicit access loss", async () => {
    let token = "first";
    const gate = barrier();
    const auth = createSessionLogin(
      () => token,
      async (value) => {
        await gate.promise;
        return session(value);
      },
    );
    const old = auth.login();
    const rejected = expect(old).rejects.toThrow("chi-mention-context-changed");
    token = "second";
    const current = auth.login();
    gate.resolve();
    await rejected;
    expect((await current).sessionToken).toBe("second");
    const another = barrier();
    const revoked = createSessionLogin(
      () => token,
      async () => {
        await another.promise;
        return session(token);
      },
    );
    const pending = revoked.login();
    const revokedResult = expect(pending).rejects.toThrow("chi-mention-context-changed");
    revoked.invalidate();
    another.resolve();
    await revokedResult;
  });
});

it("v3 platform capability requires POSIX receipt guarantees", () => {
  expect(supportsAppendCapture("win32")).toBe(false);
  expect(supportsAppendCapture("darwin")).toBe(true);
  expect(supportsAppendCapture("linux")).toBe(true);
});

it.runIf(process.platform === "win32")(
  "unsupported platform stops before credential or native access",
  async () => {
    const f = await fixture();
    const agent = await f.registration.register("ses_fork", {});
    const login = vi.spyOn(f.authority, "login");
    await expect(f.restart().capture(agent.id)).rejects.toThrow("chi-native-platform-unsupported");
    expect(login).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.runtime.export).not.toHaveBeenCalled();
  },
);

describe.skipIf(process.platform === "win32")(
  "v3 sync and mention admission (POSIX receipts)",
  () => {
    async function mapped() {
      const f = await fixture();
      const agent = await f.registration.register("ses_fork", {});
      return { ...f, agent, connection: f.restart() };
    }
    it.each(["capture-local-secret-rejected", "capture-head-diverged", "append-http-503"])(
      "keeps the people directory available when another session has %s",
      async (error) => {
        const f = await mapped();
        f.agents.push({
          ...f.agent,
          id: "other-agent",
          labels: {
            "chi.native": JSON.stringify({
              repo: f.input.repo,
              actor: "github:owner",
              sourceId: null,
              head: null,
              destination: "fixture",
              endpoint: f.authority.endpoint,
              audience: "shared",
              error,
            }),
          },
        });
        expect(await f.connection.syncStatus(f.input)).toMatchObject({
          error,
          pending: false,
          mentionsAvailable: true,
        });
        const scope = await f.connection.mentionOperation(f.home, "workspace", { action: "scope" });
        expect(
          await f.connection.mentionOperation(
            f.home,
            "workspace",
            { action: "participants" },
            scope.context,
          ),
        ).toMatchObject({ result: { kind: "participants", participants: [] } });
        expect(f.runtime.export).not.toHaveBeenCalled();
        expect(f.backend.entries).toEqual([]);
      },
    );

    it("directory availability does not grant repository access", async () => {
      const f = await mapped();
      f.request.mockImplementation(async (url, init) =>
        new URL(String(url)).pathname === "/participants"
          ? Response.json({ ok: false }, { status: 403 })
          : f.serve(url, init),
      );
      expect(await f.connection.syncStatus(f.input)).toMatchObject({ mentionsAvailable: true });
      await expect(
        f.connection.mentionOperation(f.home, "workspace", { action: "scope" }),
      ).rejects.toThrow("chi-mentions-http-403");
      expect(f.runtime.export).not.toHaveBeenCalled();
    });

    it("keeps local and multiple destinations out of the primary people directory", async () => {
      const f = await mapped();
      const multiple = fixtureConfig();
      const destinations = {
        ...multiple.destinations,
        peer: { name: "Peer", endpoint: "https://peer.invalid" },
      };
      for (const config of [null, { ...multiple, destinations }]) {
        const connection = new ChiConnection(f.manager, {
          home: f.home,
          serverId: "server",
          authority: f.authority,
          getChiConfig: () => config,
        });
        expect(await connection.syncStatus(f.input)).toMatchObject({ mentionsAvailable: false });
      }
      expect(f.request).not.toHaveBeenCalled();
    });

    it.each([
      undefined,
      {},
      { appendLog: { v: 3, deployment: "fixture" } },
      { appendLog: { v: 2, deployment: "fixture" }, handoffs: { v: 3, references: "pin-seq" } },
      { appendLog: { v: 3, deployment: "fixture" }, handoffs: { v: 3, references: "snapshot" } },
    ])(
      "refuses absent/unknown v3 capabilities before export or upload: %j",
      async (capabilities) => {
        const f = await mapped();
        f.backend.capabilities = capabilities;
        await expect(f.connection.capture(f.agent.id)).rejects.toThrow("chi-native-v3-required");
        expect(f.runtime.export).not.toHaveBeenCalled();
        expect(f.backend.entries).toEqual([]);
      },
    );
    it("maps one source, confirms a v3 pin, then appends only new settled entries", async () => {
      const f = await mapped();
      const first = await f.connection.capture(f.agent.id);
      expect(first.pin?.count).toBe(1);
      expect(first.capturePending).toBe(false);
      expect(first.actor).toBe("github:owner");
      f.transfer.messages.push({ ...f.transfer.messages[0]!, id: "msg_next", text: "next" });
      const second = await f.connection.capture(f.agent.id);
      expect(second.pin?.count).toBe(2);
      expect(second.sourceId).toBe(first.sourceId);
      expect(f.backend.entries).toHaveLength(2);
      expect(f.runtime.import).not.toHaveBeenCalled();
      expect(f.runtime.fork).not.toHaveBeenCalled();
    });
    it("keeps an unmapped workspace local before credentials or native export", async () => {
      const f = await mapped();
      const login = vi.spyOn(f.authority, "login");
      const connection = new ChiConnection(f.manager, {
        home: f.home,
        serverId: "server",
        authority: f.authority,
        getChiConfig: () => ({ ...fixtureConfig(), mappings: [] }),
      });
      await expect(connection.capture(f.agent.id)).rejects.toThrow("chi-share-required");
      expect(login).not.toHaveBeenCalled();
      expect(f.runtime.export).not.toHaveBeenCalled();
    });
    it("a misbound native checkout cannot upload through another repository's mapping", async () => {
      const f = await mapped();
      const other = await mkdtemp(join(tmpdir(), "chi-other-checkout-"));
      homes.push(other);
      f.transfer.info.location.directory = other;
      await expect(f.connection.capture(f.agent.id)).rejects.toThrow(
        "chi-native-workspace-mismatch",
      );
      expect(f.backend.entries).toEqual([]);
      expect(JSON.parse(f.agents[0]!.labels["chi.native"]!).capturePending).toBe(false);
    });
    it("refuses old snapshot associations without manufacturing a pin or recreating their source", async () => {
      const f = await mapped();
      await f.manager.updateAgentLabel(f.agent.id, "chi.native", () =>
        JSON.stringify({
          repo: f.input.repo,
          actor: "github:owner",
          sourceId: "a".repeat(64),
          head: "b".repeat(64),
          error: null,
          destination: "fixture",
          endpoint: LEGACY_ENDPOINT,
          audience: "shared",
        }),
      );
      const login = vi.spyOn(f.authority, "login");
      await expect(f.connection.capture(f.agent.id)).rejects.toThrow("chi-native-reset-required");
      expect(login).not.toHaveBeenCalled();
      expect(f.runtime.export).not.toHaveBeenCalled();
      expect(f.backend.entries).toEqual([]);
    });
    it("refuses deferred transfer operations before authorization or runtime mutation", async () => {
      const f = await fixture();
      await expect(f.restart().continue(f.input, f.registration)).rejects.toThrow(
        "chi-operation-unsupported",
      );
      await expect(
        f.restart().prepare("agent", "transfer", {
          instanceId: "other",
          workspace: { hostId: "other", path: "/fixture" },
        }),
      ).rejects.toThrow("chi-operation-unsupported");
      await expect(f.restart().reconcile("agent", true)).rejects.toThrow(
        "chi-operation-unsupported",
      );
      expect(f.request).not.toHaveBeenCalled();
      expect(f.runtime.import).not.toHaveBeenCalled();
      expect(f.runtime.fork).not.toHaveBeenCalled();
    });
    it("retains old receipt quarantine even though Continue is unavailable", async () => {
      const f = await fixture();
      const canonical = { conversationId: "conversation", transferId: "transfer" };
      const destination = {
        instanceId: "server:opencode",
        workspace: { hostId: "server", path: f.home },
      };
      const key = createHash("sha256")
        .update(JSON.stringify([f.input.repo, canonical.conversationId, canonical.transferId]))
        .digest("hex");
      await writeFile(
        join(f.home, "chi", "receipts", `${key}.claim.json`),
        JSON.stringify({
          identity: {
            ...f.input,
            endpoint: LEGACY_ENDPOINT,
            actor: "github:owner",
            destination,
            canonical,
          },
          claim: { id: canonical.conversationId, transferId: canonical.transferId, destination },
        }),
        { mode: 0o600 },
      );
      await writeFile(join(f.home, "chi", "receipts", `${key}.json`), JSON.stringify(f.receipt), {
        mode: 0o600,
      });
      await expect(
        f.restart().assertImportAllowed({
          provider: "opencode",
          providerHandleId: "ses_fork",
          cwd: f.home,
          workspaceId: f.input.workspaceId,
        }),
      ).rejects.toThrow("chi-conversation-recovery-required");
    });
    it("rechecks settlement when a same-sized completed-turn set changes during export", async () => {
      const f = await mapped();
      f.agents[0]!.finalizedForegroundTurnIds.add("old");
      vi.mocked(f.runtime.export).mockImplementation(async () => {
        f.agents[0]!.finalizedForegroundTurnIds = new Set(["new"]);
        return f.transfer;
      });
      await expect(f.connection.capture(f.agent.id)).rejects.toThrow("chi-session-busy");
      expect(f.backend.entries).toEqual([]);
    });
    it("stops divergent native history without losing the confirmed pin", async () => {
      const f = await mapped(),
        first = await f.connection.capture(f.agent.id);
      f.transfer.messages[0]!.text = "edited";
      await expect(f.connection.capture(f.agent.id)).rejects.toThrow("append-recovery-required");
      const association = JSON.parse(f.agents[0]!.labels["chi.native"]!);
      expect(association.pin).toEqual(first.pin);
      expect(association.capturePending).toBe(false);
      expect(f.backend.entries).toHaveLength(1);
    });
    it("replays a saved operation after a lost response and restarts with no duplicate", async () => {
      const f = await mapped();
      let lost = true;
      f.request.mockImplementation(async (url, init) => {
        const response = await f.serve(url, init);
        if (String(url).endsWith("/evidence") && lost) {
          lost = false;
          throw new Error("private diagnostics");
        }
        return response;
      });
      const first = await f.connection.capture(f.agent.id);
      expect(first.pin?.count).toBe(1);
      const second = await f.restart().capture(f.agent.id);
      expect(second.pin).toEqual(first.pin);
      expect(f.backend.entries).toHaveLength(1);
    });
    it("a local scan failure commits no batch and surfaces its fixed code", async () => {
      const f = await mapped();
      f.scan.mockRejectedValue(new Error("capture-local-secret-rejected"));
      await expect(f.connection.capture(f.agent.id)).rejects.toThrow(
        "capture-local-secret-rejected",
      );
      expect(f.backend.entries).toEqual([]);
      expect(JSON.parse(f.agents[0]!.labels["chi.native"]!).capturePending).toBe(false);
    });
    it("unsupported native numeric values stop sync rather than entering divergence recovery or retry", async () => {
      const f = await mapped();
      f.transfer.info.cost = Infinity;
      await expect(f.connection.capture(f.agent.id)).rejects.toThrow(
        "capture-native-projection-invalid",
      );
      expect(f.backend.entries).toEqual([]);
      expect(JSON.parse(f.agents[0]!.labels["chi.native"]!).capturePending).toBe(false);
    });
    it("denied unchanged-source verification clears success and stops automatic capture", async () => {
      const f = await mapped();
      await f.connection.capture(f.agent.id);
      f.backend.allowed = false;
      await expect(f.connection.capture(f.agent.id)).rejects.toThrow("append-http-404");
      expect(JSON.parse(f.agents[0]!.labels["chi.native"]!).capturePending).toBe(false);
      expect(f.backend.entries).toHaveLength(1);
    });
    it("refuses a delayed confirmation after the host identity changed", async () => {
      const f = await mapped();
      let switched = false;
      f.request.mockImplementation(async (url, init) => {
        if (String(url).endsWith("/auth/session") && switched)
          return Response.json({
            ok: true,
            chiUserId: "github:other",
            capabilities: f.backend.capabilities,
          });
        const response = await f.serve(url, init);
        if (String(url).endsWith("/evidence")) switched = true;
        return response;
      });
      vi.spyOn(f.authority, "login").mockImplementation(async () => ({
        chiUserId: switched ? "github:other" : "github:owner",
        sessionToken: "fixture",
      }));
      await expect(f.connection.capture(f.agent.id)).rejects.toThrow("chi-mention-context-changed");
      expect(JSON.parse(f.agents[0]!.labels["chi.native"]!).pin).toBeUndefined();
    });
    it("a delayed confirmation cannot overwrite a newly scoped association", async () => {
      const f = await mapped();
      function retarget(encoded: string | undefined) {
        return JSON.stringify({
          ...JSON.parse(z.string().parse(encoded)),
          repo: "github:other/repo",
        });
      }
      f.request.mockImplementation(async (url, init) => {
        const response = await f.serve(url, init);
        if (String(url).endsWith("/evidence")) {
          await f.manager.updateAgentLabel(f.agent.id, "chi.native", retarget);
        }
        return response;
      });
      await expect(f.connection.capture(f.agent.id)).rejects.toThrow("chi-mention-context-changed");
      const current = JSON.parse(f.agents[0]!.labels["chi.native"]!);
      expect(current.repo).toBe("github:other/repo");
      expect(current.pin).toBeUndefined();
    });
    it("never retargets a delayed capture after a destination change", async () => {
      const f = await mapped();
      const config = fixtureConfig();
      const connection = new ChiConnection(f.manager, {
        home: f.home,
        serverId: "server",
        authority: f.authority,
        getChiConfig: () => config,
        scanCapture: f.scan,
        appendScanner: { command: f.scanner },
      });
      vi.mocked(f.runtime.export).mockImplementation(async () => {
        config.destinations.fixture.endpoint = "https://other.invalid";
        return f.transfer;
      });
      await expect(connection.capture(f.agent.id)).rejects.toThrow("chi-destination-changed");
      expect(f.backend.entries).toEqual([]);
      expect(
        f.request.mock.calls.some(([url]) => String(url).startsWith("https://other.invalid")),
      ).toBe(false);
    });
    it("participant scope binds deployment and rejects a stale or unversioned context", async () => {
      const f = await mapped();
      const scope = await f.connection.mentionOperation(f.home, f.input.workspaceId, {
        action: "scope",
      });
      expect(scope.context.evidenceVersion).toBe(3);
      await expect(
        f.connection.mentionOperation(
          f.home,
          f.input.workspaceId,
          { action: "participants" },
          { ...scope.context, evidenceVersion: undefined },
        ),
      ).rejects.toThrow("chi-mention-context-changed");
      f.backend.capabilities = {
        appendLog: { v: 3, deployment: "other" },
        handoffs: { v: 3, references: "pin-seq" },
      };
      await expect(
        f.connection.mentionOperation(
          f.home,
          f.input.workspaceId,
          { action: "participants" },
          scope.context,
        ),
      ).rejects.toThrow("chi-mention-context-changed");
    });
    it("deployment inbox requires an explicit repository from its authorized catalog", async () => {
      const f = await mapped();
      const scope = await f.connection.inboxOperation({ action: "scope" });
      expect(scope.context.repositories).toEqual([f.input.repo]);
      await expect(
        f.connection.inboxOperation({ action: "inbox", inbox: true }, scope.context),
      ).rejects.toThrow("chi-mention-repository-required");
      await expect(
        f.connection.inboxOperation(
          { action: "inbox", inbox: true, repo: "github:foreign/repo" },
          scope.context,
        ),
      ).rejects.toThrow("chi-repository-denied");
    });
    it("a delayed repository catalog cannot escape an account switch during scope acquisition", async () => {
      const f = await mapped();
      let switched = false;
      vi.spyOn(f.authority, "login").mockImplementation(async () => ({
        chiUserId: switched ? "github:other" : "github:owner",
        sessionToken: "fixture",
      }));
      f.request.mockImplementation(async (url, init) => {
        if (String(url).endsWith("/auth/session") && switched)
          return Response.json({
            ok: true,
            chiUserId: "github:other",
            capabilities: f.backend.capabilities,
          });
        const response = await f.serve(url, init);
        if (String(url).endsWith("/repos")) switched = true;
        return response;
      });
      await expect(f.connection.inboxOperation({ action: "scope" })).rejects.toThrow(
        "chi-mention-context-changed",
      );
      expect(f.request.mock.calls.some(([url]) => String(url).includes("/handoffs"))).toBe(false);
    });
    it("keeps public errors fixed and scan timeout distinct", () => {
      expect(safeChiError(new Error("capture-local-scan-timeout"))).toBe(
        "capture-local-scan-timeout",
      );
      expect(safeChiError(new Error("private payload diagnostic"))).toBe("chi-operation-failed");
    });
  },
);
