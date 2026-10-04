import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ChiMentions, hasMention } from "./mentions.js";
import {
  ChiHandoffSchema,
  ChiMentionResultSchema,
  type ChiHandoff,
} from "@getpaseo/protocol/chi-mentions";
import { MessageReceipts } from "../message-receipts/index.js";
import {
  mentionFixtureTitle,
  purgeMentionFixtureSources,
} from "../test-utils/chi-mention-fixture-sources.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "chi-mentions-"));
  homes.push(home);
  const records = new Map<string, ChiHandoff>();
  const submissions: unknown[] = [];
  const reads: URL[] = [];
  let failAfterCommit = false;
  let denied = false;
  const identity = { repo: "github:fixture/repo", actor: "github:sender", token: "fixture" };
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
            sources: ChiHandoffSchema.shape.sources,
          })
          .parse(JSON.parse(String(init.body)));
        submissions.push(value);
        const existing = records.get(value.id);
        const handoff =
          existing ??
          ChiHandoffSchema.parse({
            ...value,
            schemaVersion: 1,
            repo: identity.repo,
            author: identity.actor,
            state: "open",
            revision: 1,
            createdAt: "2026-09-25T00:00:00Z",
            updatedAt: "2026-09-25T00:00:00Z",
            events: [],
          });
        records.set(value.id, handoff);
        if (failAfterCommit) {
          failAfterCommit = false;
          throw new Error("socket lost after commit");
        }
        return Response.json({ ok: true, handoff });
      }
      if (target.pathname === "/api/handoffs" && init?.method === "GET")
        return Response.json({ ok: true, handoff: records.get(target.searchParams.get("id")!) });
      if (target.pathname === "/api/evidence/exact")
        return Response.json({
          snapshot: target.searchParams.get("snapshot"),
          entry: { nativeId: target.searchParams.get("entryId") },
          native: { text: "exact content" },
        });
      if (target.pathname === "/api/evidence/inspect")
        return Response.json({
          sourceId: target.searchParams.get("sourceId"),
          nativeSessionId: "ses_source",
          workspace: { hostId: "host" },
        });
      if (target.pathname === "/api/evidence/entries")
        return Response.json({
          snapshot: target.searchParams.get("snapshot"),
          items: [{ nativeId: "neighbor", type: "assistant" }],
          nextCursor: null,
        });
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
  const capture = {
    identity,
    agentId: "agent",
    sourceId: "a".repeat(64),
    snapshot: "b".repeat(64),
    messages: [
      {
        id: "exact_native_user_id",
        payload: {
          id: "exact_native_user_id",
          type: "user",
          text: input.text,
          metadata: { paseoClientMessageId: input.messageId },
        },
      },
    ],
  };
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
      : Response.json({ ok: true, handoffs: [], nextCursor: null, unreadCount: 0 });
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

test("inbox carries incomplete coverage through backend and wire parsing; legacy pages remain valid", async () => {
  const f = await fixture();
  for (const unavailableRepos of [undefined, [], ["github:fixture/broken"]]) {
    for (const unreadCountIsLowerBound of [undefined, true]) {
      f.authority.request = async () =>
        Response.json({
          ok: true,
          handoffs: [],
          nextCursor: "next",
          unreadCount: 3,
          ...(unreadCountIsLowerBound ? { unreadCountIsLowerBound } : {}),
          ...(unavailableRepos ? { unavailableRepos } : {}),
        });
      const result = await f.restart().execute(f.input.identity, { action: "inbox", inbox: true });
      const parsed = ChiMentionResultSchema.parse(result);
      expect(parsed).toEqual({
        kind: "inbox",
        actor: f.input.identity.actor,
        handoffs: [],
        nextCursor: "next",
        unreadCount: 3,
        ...(unreadCountIsLowerBound ? { unreadCountIsLowerBound } : {}),
        ...(unavailableRepos ? { unavailableRepos } : {}),
      });
    }
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
  await sender.prepare(f.input);
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
  await f.restart().captured({ ...f.capture, snapshot: "c".repeat(64) });
  expect(f.submissions).toHaveLength(2);
  expect(f.submissions[1]).toEqual(f.submissions[0]);
  expect([...f.records.values()][0]?.sources).toEqual([
    {
      kind: "neutral",
      id: f.capture.sourceId,
      snapshot: f.capture.snapshot,
      entryId: "exact_native_user_id",
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
      { id: "assistant", payload: { ...f.capture.messages[0]!.payload, type: "assistant" } },
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
  const source = await sender.execute(f.input.identity, { action: "source", id, index: 0 });
  expect(source).toMatchObject({
    kind: "source",
    source: { entryId: "exact_native_user_id", snapshot: f.capture.snapshot },
    payload: JSON.stringify({ text: "exact content" }, null, 2),
  });
  await sender.execute(f.input.identity, { action: "context", id, index: 0 });
  await sender.execute(f.input.identity, { action: "source", id, index: 0, entryId: "neighbor" });
  const evidence = f.reads.filter(
    (url) => url.pathname === "/api/evidence/exact" || url.pathname === "/api/evidence/entries",
  );
  expect(evidence).toHaveLength(3);
  for (const url of evidence) {
    expect(url.searchParams.get("sourceId")).toBe(f.capture.sourceId);
    expect(url.searchParams.get("snapshot")).toBe(f.capture.snapshot);
  }
  expect(evidence[2]!.searchParams.get("entryId")).toBe("neighbor");
  f.deny();
  await expect(
    sender.execute(f.input.identity, { action: "source", id, index: 0 }),
  ).rejects.toThrow("chi-mentions-http-403");
  expect(f.reads.filter((url) => url.pathname.startsWith("/api/evidence/"))).toHaveLength(5);
});
