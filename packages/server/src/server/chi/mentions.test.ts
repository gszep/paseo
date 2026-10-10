import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ChiMentions, hasMention } from "./mentions.js";
import {
  ChiMentionResultSchema,
  ChiEntryRefSchema,
  type ChiEntryRef,
  type ChiHandoff,
} from "@getpaseo/protocol/chi-mentions";
import { MessageReceipts } from "../message-receipts/index.js";
import { encodeEntry, type Pin } from "@henkaku-center/chi-native/append-codec";
import {
  mentionFixtureTitle,
  purgeMentionFixtureSources,
} from "../test-utils/chi-mention-fixture-sources.js";

const homes: string[] = [];
type WireHandoff = Omit<ChiHandoff, "schemaVersion" | "sources" | "events"> & {
  v: 3;
  sources: ChiEntryRef[];
};
afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "chi-mentions-"));
  homes.push(home);
  const records = new Map<string, WireHandoff>();
  const submissions: unknown[] = [];
  const reads: URL[] = [];
  let failAfterCommit = false;
  let denied = false;
  const identity = {
    repo: "github:fixture/repo",
    actor: "github:sender",
    token: "fixture",
    deployment: "fixture",
  };
  const authority = {
    endpoint: "https://chi.invalid/api",
    request: (async (url, init) => {
      if (denied) return new Response("private diagnostics", { status: 403 });
      const target = new URL(String(url));
      reads.push(target);
      expect(target.origin).toBe("https://chi.invalid");
      expect(init?.redirect).toBe("error");
      if (target.pathname === "/api/participants")
        return Response.json({
          ok: true,
          self: identity.actor,
          participants: [{ ownerId: "github:steffenpl", handle: "SteffenPL" }],
        });
      if (target.pathname === "/api/handoffs" && init?.method === "POST") {
        const value = z
          .object({
            id: z.string(),
            recipient: z.string(),
            text: z.string(),
            workspaceName: z.string().optional(),
            v: z.literal(3),
            sources: z.array(ChiEntryRefSchema),
          })
          .parse(JSON.parse(String(init.body)));
        submissions.push(value);
        const existing = records.get(value.id);
        const handoff: WireHandoff = existing ?? {
          ...value,
          repo: identity.repo,
          author: identity.actor,
          state: "open",
          revision: 1,
          createdAt: "2026-09-25T00:00:00Z",
          updatedAt: "2026-09-25T00:00:00Z",
        };
        records.set(value.id, handoff);
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error("socket lost after commit");
        }
        return Response.json({ ok: true, handoff, replay: existing !== undefined });
      }
      if (target.pathname === "/api/handoffs" && init?.method === "GET")
        return Response.json({ ok: true, handoff: records.get(target.searchParams.get("id")!) });
      if (
        target.pathname === "/api/evidence/exact" ||
        target.pathname === "/api/evidence/entries"
      ) {
        const pin = JSON.parse(target.searchParams.get("pin")!);
        expect(pin).toEqual(capture.pin);
        const start = Number(target.searchParams.get("start"));
        const end = target.pathname.endsWith("exact")
          ? start + 1
          : Number(target.searchParams.get("end"));
        return Response.json({
          entries: archive.slice(start, end).map((native, index) =>
            encodeEntry({
              v: 3,
              seq: start + index,
              kind: "message",
              minimiser: "min-v1",
              payload: { native: JSON.stringify(native) },
            }),
          ),
        });
      }
      throw new Error("unexpected fixture operation");
    }) satisfies typeof fetch,
  };
  const input = {
    admission: "",
    identity,
    agentId: "agent",
    messageId: "client-message",
    text: "@SteffenPL please check",
    recipients: ["github:SteffenPL"],
  };
  const requests = new MessageReceipts(join(home, "agent-requests"));
  await requests.send({
    durable: true,
    agentId: input.agentId,
    messageId: input.messageId,
    request: { text: input.text, recipients: input.recipients },
    prepare: async (fingerprint) => {
      input.admission = fingerprint;
    },
    send: async () => undefined,
  });
  const pin: Pin = {
    v: 3,
    deployment: "fixture",
    repo: identity.repo,
    sourceId: "a".repeat(64),
    count: 2,
    head: "b".repeat(64),
  };
  const capture = {
    identity,
    agentId: "agent",
    pin,
    messages: [
      {
        id: "msg_exact",
        seq: 0,
        payload: {
          id: "msg_exact",
          type: "user",
          time: { created: 1 },
          text: input.text,
          metadata: { paseoClientMessageId: input.messageId },
        },
      },
    ],
  };
  const archive = [
    capture.messages[0]!.payload,
    { id: "msg_neighbor", type: "user", text: "neighbor", time: { created: 2 } },
  ];
  const restart = () => new ChiMentions(home, authority);
  return {
    restart,
    home,
    authority,
    input,
    capture,
    records,
    submissions,
    reads,
    archive,
    loseReply: () => {
      failAfterCommit = true;
    },
    deny: () => {
      denied = true;
    },
  };
}

test("inbox retries a read fence conflict but does not automatically retry a mutation", async () => {
  const f = await fixture();
  let attempts = 0;
  f.authority.request = (async () => {
    attempts++;
    return attempts === 1
      ? new Response(null, { status: 409 })
      : Response.json({
          handoffs: [],
          nextCursor: null,
          unreadCount: 0,
          unreadCountLowerBound: false,
        });
  }) satisfies typeof fetch;
  expect(
    await f.restart().execute(f.input.identity, { action: "inbox", inbox: true }),
  ).toMatchObject({ kind: "inbox", handoffs: [], unreadCount: 0 });
  expect(attempts).toBe(2);
  attempts = 0;
  await expect(
    f.restart().execute(f.input.identity, {
      action: "viewed",
      repo: f.input.identity.repo,
      id: "record",
      revision: 1,
    }),
  ).rejects.toThrow("chi-mentions-http-409");
  expect(attempts).toBe(1);
});

test("per-repository inbox carries the v3 unread lower bound through the daemon protocol", async () => {
  const f = await fixture();
  for (const unreadCountIsLowerBound of [false, true]) {
    f.authority.request = async () =>
      Response.json({
        handoffs: [],
        nextCursor: "next",
        unreadCount: 3,
        unreadCountLowerBound: unreadCountIsLowerBound,
      });
    const result = await f.restart().execute(f.input.identity, { action: "inbox", inbox: true });
    const parsed = ChiMentionResultSchema.parse(result);
    expect(parsed).toEqual({
      kind: "inbox",
      actor: f.input.identity.actor,
      handoffs: [],
      nextCursor: "next",
      unreadCount: 3,
      unreadCountIsLowerBound,
    });
  }
});

test("inbox invalid cursor has a fixed recovery code and never exposes backend diagnostics", async () => {
  const f = await fixture();
  f.authority.request = async () =>
    Response.json({ reason: "invalid-cursor", diagnostics: "private" }, { status: 400 });
  await expect(
    f.restart().execute(f.input.identity, { action: "inbox", inbox: true, cursor: "old" }),
  ).rejects.toThrow(/^chi-inbox-invalid-cursor$/);
  f.authority.request = async () =>
    Response.json({ reason: "private diagnostics" }, { status: 400 });
  await expect(
    f.restart().execute(f.input.identity, { action: "inbox", inbox: true }),
  ).rejects.toThrow(/^chi-mentions-http-400$/);
});

test("durable delivery pins the persisted native user entry and replays the same handoff after a lost reply and restart", async () => {
  const f = await fixture();
  const sender = f.restart();
  await sender.prepare({ ...f.input, workspaceName: "Release planning" });
  const pending = await sender.status("agent", f.input.identity);
  expect(pending.kind).toBe("delivery");
  f.loseReply();
  await sender.captured(f.capture);
  expect(f.records.size).toBe(1);
  expect(await f.restart().status("agent", f.input.identity)).toMatchObject({
    deliveries: [
      { status: "failed", recipient: { ownerId: "github:steffenpl", handle: "SteffenPL" } },
    ],
  });
  await f
    .restart()
    .captured({ ...f.capture, pin: { ...f.capture.pin, head: "c".repeat(64), count: 3 } });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]).toEqual(f.submissions[0]);
  expect([...f.records.values()][0]?.workspaceName).toBe("Release planning");
  expect([...f.records.values()][0]?.sources).toEqual([
    {
      pin: f.capture.pin,
      seq: 0,
    },
  ]);
  expect(await f.restart().status("agent", f.input.identity)).toMatchObject({
    deliveries: [{ status: "delivered", error: null }],
  });
});

test("restart after intent publication cannot activate the intent through an ordinary same-ID/text send", async () => {
  const f = await fixture();
  const requests = new MessageReceipts(join(f.home, "agent-requests"));
  const input = { ...f.input, messageId: "crash-boundary" };
  let admission = "";
  await expect(
    requests.send({
      durable: true,
      agentId: input.agentId,
      messageId: input.messageId,
      request: { text: input.text, recipients: input.recipients },
      prepare: async (fingerprint) => {
        admission = fingerprint;
        await f.restart().prepare({ ...input, admission });
        throw new Error("process stopped before pending receipt");
      },
      send: async () => {
        throw new Error("must not reach provider");
      },
    }),
  ).rejects.toThrow("process stopped");
  const restarted = new MessageReceipts(join(f.home, "agent-requests"));
  expect(await restarted.admits(input.agentId, input.messageId, admission)).toBe(false);
  await expect(
    restarted.send({
      agentId: input.agentId,
      messageId: input.messageId,
      request: { text: input.text },
      send: async () => {
        throw new Error("must not send ordinary message");
      },
    }),
  ).rejects.toThrow("agent_request_key_conflict");
  const capture = {
    ...f.capture,
    messages: [
      {
        ...f.capture.messages[0]!,
        payload: {
          ...f.capture.messages[0]!.payload,
          metadata: { paseoClientMessageId: input.messageId },
        },
      },
    ],
  };
  f.archive[0] = capture.messages[0]!.payload;
  await f.restart().captured(capture);
  await f.restart().retry(input.agentId, input.identity);
  expect(f.submissions).toEqual([]);
  await restarted.send({
    durable: true,
    agentId: input.agentId,
    messageId: input.messageId,
    request: { text: input.text, recipients: input.recipients },
    prepare: async (fingerprint) => {
      await f.restart().prepare({ ...input, admission: fingerprint });
    },
    send: async () => undefined,
  });
  await f.restart().captured(capture);
  expect(f.submissions).toHaveLength(1);
});

test("never substitutes a matching assistant message or guesses a native ID for an unpersisted prompt", async () => {
  const f = await fixture();
  const sender = f.restart();
  await sender.prepare(f.input);
  await sender.captured({
    ...f.capture,
    messages: [
      {
        id: "msg_assistant",
        seq: 0,
        payload: { ...f.capture.messages[0]!.payload, type: "assistant" },
      },
    ],
  });
  expect(f.submissions).toEqual([]);
  expect(await sender.status("agent", f.input.identity)).toMatchObject({
    deliveries: [{ status: "failed", error: "chi-mention-persisted-entry-required" }],
  });
  await expect(sender.prepare({ ...f.input, text: "@SteffenPL changed" })).rejects.toThrow(
    "chi-mention-conflict",
  );
  await sender.captured(f.capture);
  expect(f.submissions).toHaveLength(1);
});

test("revalidates delivery access, sanitizes failures and never exposes another actor's local outbox", async () => {
  const f = await fixture();
  const sender = f.restart();
  await sender.prepare(f.input);
  f.deny();
  await sender.captured(f.capture);
  expect(await sender.status("agent", f.input.identity)).toMatchObject({
    deliveries: [{ status: "failed", error: "chi-mentions-http-403" }],
  });
  expect(await sender.status("agent", { ...f.input.identity, actor: "github:other" })).toEqual({
    kind: "delivery",
    actor: "github:other",
    deliveries: [],
  });
  expect(f.records.size).toBe(0);
  expect(await sender.status("agent", { ...f.input.identity, deployment: "other" })).toEqual({
    kind: "delivery",
    actor: f.input.identity.actor,
    deliveries: [],
  });
});

test("a metadata ordinal cannot authorize a mention even if its native text impersonates the user entry", async () => {
  const f = await fixture();
  const request = f.authority.request;
  f.authority.request = async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/evidence/exact"))
      return Response.json({
        entries: [
          encodeEntry({
            v: 3,
            seq: 0,
            kind: "metadata",
            minimiser: "min-v1",
            payload: { native: JSON.stringify(f.capture.messages[0]!.payload) },
          }),
        ],
      });
    return request(url, init);
  };
  await f.restart().prepare(f.input);
  await f.restart().captured(f.capture);
  expect(f.submissions).toEqual([]);
  expect(await f.restart().status("agent", f.input.identity)).toMatchObject({
    deliveries: [{ status: "failed", error: "chi-mention-invalid-response" }],
  });
});

test("a cross-deployment pin stops before protected lookup or handoff publication", async () => {
  const f = await fixture();
  await f.restart().prepare(f.input);
  const reads = f.reads.length;
  await expect(
    f.restart().captured({ ...f.capture, pin: { ...f.capture.pin, deployment: "other" } }),
  ).rejects.toThrow("chi-mention-invalid-response");
  expect(f.reads).toHaveLength(reads);
  expect(f.submissions).toEqual([]);
});

test("v3 refuses deferred writes and enforces the UTF-8 mention bound", async () => {
  const f = await fixture();
  await expect(
    f.restart().prepare({ ...f.input, text: "@SteffenPL " + "雪".repeat(3000) }),
  ).rejects.toThrow("chi-mention-text-too-long");
  expect(f.reads).toEqual([]);
  await expect(
    f.restart().execute(f.input.identity, {
      action: "reply",
      id: "00000000-0000-4000-8000-000000000001",
      operationId: "00000000-0000-4000-8000-000000000002",
      revision: 1,
      text: "reply",
    }),
  ).rejects.toThrow("chi-operation-unsupported");
  expect(f.reads).toEqual([]);
});

test("human mentions reject file and email adjacency", () => {
  expect(hasMention("@SteffenPL check", "SteffenPL")).toBe(true);
  expect(hasMention("(@steffenpl)", "SteffenPL")).toBe(true);
  for (const text of ["me@SteffenPL", "./@SteffenPL", "@SteffenPL/file", "@SteffenPL-extra"])
    expect(hasMention(text, "SteffenPL")).toBe(false);
});

test("acceptance startup purges only its actor's marked sources, after collecting every page", async () => {
  const removed: string[] = [];
  const cursors: Array<string | null> = [];
  await purgeMentionFixtureSources({
    actor: "sava-the-owl",
    list: async (cursor) => {
      expect(removed).toEqual([]);
      cursors.push(cursor);
      if (!cursor)
        return {
          items: [
            {
              sourceId: "legacy-orphan",
              title: mentionFixtureTitle,
              ownerId: "github:sava-the-owl",
            },
            {
              sourceId: "other-owner",
              title: `${mentionFixtureTitle} old-run`,
              ownerId: "github:other",
            },
            { sourceId: "real-session", title: "My work", ownerId: "github:sava-the-owl" },
          ],
          nextCursor: "second",
        };
      return {
        items: [
          {
            sourceId: "marked-orphan",
            title: `${mentionFixtureTitle} old-run`,
            ownerId: "github:sava-the-owl",
          },
        ],
        nextCursor: null,
      };
    },
    remove: async (id) => {
      removed.push(id);
    },
  });
  expect(cursors).toEqual([null, "second"]);
  expect(removed).toEqual(["legacy-orphan", "marked-orphan"]);
});

test("exact metadata cannot authorize transformed or duplicate user entries", async () => {
  const f = await fixture();
  const sender = f.restart();
  await sender.prepare(f.input);
  const message = f.capture.messages[0]!;
  await sender.captured({
    ...f.capture,
    messages: [
      { ...message, payload: { ...message.payload, text: `${f.input.text}\nexpanded attachment` } },
    ],
  });
  expect(f.submissions).toEqual([]);
  await sender.captured({
    ...f.capture,
    messages: [message, { ...message, id: "second-native-user" }],
  });
  expect(f.submissions).toEqual([]);
  await sender.captured(f.capture);
  expect(f.submissions).toHaveLength(1);
});

test("source and neighboring context reads reacquire the handoff and retain its pinned snapshot", async () => {
  const f = await fixture();
  const sender = f.restart();
  await sender.prepare(f.input);
  await sender.captured(f.capture);
  const id = [...f.records.keys()][0]!;
  await expect(
    sender.execute(f.input.identity, { action: "source", id, index: 0, entryId: "msg_neighbor" }),
  ).rejects.toThrow("chi-mention-invalid-source");
  const source = await sender.execute(f.input.identity, { action: "source", id, index: 0 });
  expect(source).toMatchObject({
    kind: "source",
    source: { entryId: "0", appendRef: { pin: f.capture.pin, seq: 0 } },
    payload: JSON.stringify(f.capture.messages[0]!.payload, null, 2),
  });
  await sender.execute(f.input.identity, { action: "context", id, index: 0 });
  await sender.execute(f.input.identity, { action: "source", id, index: 0, seq: 1 });
  const evidence = f.reads.filter(
    (url) => url.pathname === "/api/evidence/exact" || url.pathname === "/api/evidence/entries",
  );
  expect(evidence).toHaveLength(4);
  for (const url of evidence) {
    expect(JSON.parse(url.searchParams.get("pin")!)).toEqual(f.capture.pin);
  }
  expect(evidence[3]!.searchParams.get("start")).toBe("1");
  f.deny();
  await expect(
    sender.execute(f.input.identity, { action: "source", id, index: 0 }),
  ).rejects.toThrow("chi-mentions-http-403");
  expect(f.reads.filter((url) => url.pathname.startsWith("/api/evidence/"))).toHaveLength(4);
});
