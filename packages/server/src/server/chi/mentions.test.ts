import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ChiMentions, hasMention } from "./mentions.js";
import { ChiHandoffSchema, type ChiHandoff } from "@getpaseo/protocol/chi-mentions";

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
    identity,
    agentId: "agent",
    messageId: "client-message",
    text: "@SteffenPL please check",
    recipients: ["github:SteffenPL"],
  };
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
  const evidence = f.reads.filter((url) => url.pathname.startsWith("/api/evidence/"));
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
  expect(f.reads.filter((url) => url.pathname.startsWith("/api/evidence/"))).toHaveLength(3);
});
