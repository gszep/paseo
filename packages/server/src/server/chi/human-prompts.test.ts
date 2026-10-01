import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  encodeHumanAnswers,
  readHumanPrompts,
  type ChiHandoff,
  type ChiSource,
} from "@getpaseo/protocol/chi-mentions";
import { HumanPrompts, type HumanPromptScope } from "./human-prompts.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "human-prompts-"));
  homes.push(home);
  let now = Date.UTC(2026, 9, 1, 1);
  const scope: HumanPromptScope = {
    agentId: "agent",
    sessionId: "ses_native",
    turnId: "msg_native",
    context: {
      actor: "github:author",
      repo: "github:fixture/repo",
      generation: "a".repeat(64),
      deployment: "https://chi.invalid",
    },
  };
  const source: ChiSource = {
    kind: "neutral",
    id: "a".repeat(64),
    snapshot: "b".repeat(64),
    entryId: "msg_settled",
  };
  const remote = new Map<string, ChiHandoff>();
  const attempts: unknown[] = [];
  let denied = false,
    lost = false;
  const transport = {
    async create(input: { id: string; recipient: string; text: string; sources: ChiSource[] }) {
      attempts.push(structuredClone(input));
      if (denied) throw new Error("denied");
      const handoff: ChiHandoff = remote.get(input.id) ?? {
        ...input,
        schemaVersion: 1,
        repo: scope.context.repo,
        author: scope.context.actor,
        state: "open",
        revision: 1,
        createdAt: "now",
        updatedAt: "now",
        events: [],
      };
      remote.set(handoff.id, handoff);
      if (lost) throw new Error("lost response");
      return structuredClone(handoff);
    },
    async read(id: string) {
      if (denied) throw new Error("denied");
      return structuredClone(remote.get(id)!);
    },
  };
  const restart = () => new HumanPrompts(home, () => now);
  const service = restart();
  const add = (key: string, overrides = {}, current = scope) =>
    service.operate(
      current,
      {
        action: "add",
        dedupeKey: key,
        recipient: "github:recipient",
        kind: "question",
        priority: "blocking",
        text: "Which option?",
        ...overrides,
      },
      transport,
    );
  const flush = (current = scope, options = {}) =>
    service.boundary(current, transport, { source, viewed: false, ...options });
  return {
    home,
    scope,
    source,
    remote,
    attempts,
    transport,
    service,
    restart,
    add,
    flush,
    advance: (ms: number) => {
      now += ms;
    },
    deny: (value: boolean) => {
      denied = value;
    },
    lose: (value: boolean) => {
      lost = value;
    },
  };
}

describe("human prompt delivery receipts", () => {
  it("dedupes concurrent requests across instances and rejects changed intent", async () => {
    const f = await fixture();
    await Promise.all([f.add("stable"), f.add("stable")]);
    const first = await f.service.operate(f.scope, { action: "list" }, f.transport);
    expect(first.items).toHaveLength(1);
    await expect(f.add("stable", { text: "Changed" })).rejects.toThrow("conflict");
    const second = await f.restart().operate(f.scope, { action: "list" }, f.transport);
    expect(second).toEqual(first);
    await expect(
      f
        .restart()
        .operate(
          { ...f.scope, context: { ...f.scope.context, actor: "github:other" } },
          { action: "list" },
          f.transport,
        ),
    ).rejects.toThrow("context-changed");
    await expect(
      f.restart().operate({ ...f.scope, sessionId: "other" }, { action: "list" }, f.transport),
    ).rejects.toThrow("context-changed");
    expect(
      (await f.service.operate({ ...f.scope, agentId: "other" }, { action: "list" }, f.transport))
        .items,
    ).toEqual([]);
  });

  it("batches five bounded items, excludes FYI/notes and sends only written text and exact coordinates", async () => {
    const f = await fixture();
    for (let i = 0; i < 6; i++) await f.add(`q${i}`);
    await f.add("note", { kind: "note" });
    await f.add("fyi", { priority: "fyi" });
    await f.flush();
    expect(f.remote.size).toBe(1);
    const handoff = [...f.remote.values()][0]!;
    const batch = readHumanPrompts(handoff.text)!;
    expect(batch.items).toHaveLength(5);
    expect(batch.sessionId).toBe("ses_native");
    expect(batch.turnId).toBe("msg_native");
    expect(handoff.sources).toEqual([f.source]);
    expect(batch.items.map((i) => i.text)).toEqual(Array(5).fill("Which option?"));
    expect(Object.keys(f.attempts[0] as object).sort()).toEqual([
      "id",
      "recipient",
      "sources",
      "text",
    ]);
    await f.flush();
    expect(f.remote.size).toBe(1);
    f.advance(300000);
    await f.flush();
    expect(f.remote.size).toBe(2);
    expect(readHumanPrompts([...f.remote.values()][1]!.text)!.items).toHaveLength(1);
  });

  it("bounds escaped batch payloads without silently truncating written questions", async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) await f.add(`q${i}`, { text: '"'.repeat(2000) });
    await f.flush();
    const text = [...f.remote.values()][0]!.text;
    expect(text.length).toBeLessThanOrEqual(8000);
    expect(readHumanPrompts(text)!.items).toHaveLength(1);
    expect(readHumanPrompts(text)!.items[0]!.text).toHaveLength(2000);
  });

  it("does not let one recipient's spacing block another recipient", async () => {
    const f = await fixture();
    await f.add("first");
    await f.flush();
    await f.add("second");
    await f.add("other", { recipient: "github:other" });
    await f.flush();
    expect([...f.remote.values()].map((h) => h.recipient)).toEqual([
      "github:recipient",
      "github:other",
    ]);
  });

  it("bounds item text and durable session growth without truncation or eviction", async () => {
    const f = await fixture();
    await expect(f.add("oversized", { text: "x".repeat(2001) })).rejects.toThrow();
    for (let i = 0; i < 100; i++) await f.add(`q${i}`, { kind: "note" });
    await expect(f.add("overflow")).rejects.toThrow("limit");
    expect(
      (await f.restart().operate(f.scope, { action: "list" }, f.transport)).items,
    ).toHaveLength(100);
  });

  it("persists a host-wide per-recipient daily quota across sessions and restart", async () => {
    const f = await fixture();
    for (let i = 0; i < 9; i++) {
      const scope = { ...f.scope, agentId: `agent${i}` };
      await f.add(`q${i}`, {}, scope);
      await f.restart().boundary(scope, f.transport, { source: f.source, viewed: false });
      f.advance(300000);
    }
    expect(f.remote.size).toBe(8);
    const last = { ...f.scope, agentId: "agent8" };
    f.advance(86400000);
    await f.flush(last);
    expect(f.remote.size).toBe(9);
    const quota = join(f.home, "chi", "human-prompts", "quota.json");
    expect(await readFile(quota, "utf8")).not.toContain("Which option?");
  });

  it.skipIf(process.platform === "win32")("keeps quota receipts owner-only on POSIX", async () => {
    const f = await fixture();
    await f.add("q");
    await f.flush();
    expect((await stat(join(f.home, "chi", "human-prompts", "quota.json"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("serializes simultaneous dispatches across service instances before spending recipient quota", async () => {
    const f = await fixture();
    const scopes = Array.from({ length: 9 }, (_, i) => ({ ...f.scope, agentId: `agent${i}` }));
    await Promise.all(scopes.map((scope, i) => f.add(`q${i}`, {}, scope)));
    await Promise.all(
      scopes.map((scope) =>
        f.restart().boundary(scope, f.transport, { source: f.source, viewed: false }),
      ),
    );
    expect(f.attempts).toHaveLength(1);
    expect(f.remote.size).toBe(1);
  });

  it("charges immutable retries to their actual dispatch day and respects an exhausted new-day quota", async () => {
    const f = await fixture();
    await f.add("lost");
    f.lose(true);
    await f.flush();
    f.lose(false);
    f.advance(86400000);
    for (let i = 0; i < 8; i++) {
      const scope = { ...f.scope, agentId: `new-day-${i}` };
      await f.add(`q${i}`, {}, scope);
      await f.flush(scope);
      f.advance(300000);
    }
    await f.restart().operate(f.scope, { action: "retry" }, f.transport);
    expect(f.attempts).toHaveLength(9);
    f.advance(86400000);
    await f.restart().operate(f.scope, { action: "retry" }, f.transport);
    expect(f.attempts).toHaveLength(10);
    expect(f.attempts[9]).toEqual(f.attempts[0]);
    const quota = JSON.parse(
      await readFile(join(f.home, "chi", "human-prompts", "quota.json"), "utf8"),
    );
    expect(quota).toHaveLength(1);
  });

  it("mute, snooze, active viewing and missing evidence cannot dispatch or spend quota", async () => {
    const f = await fixture();
    await f.add("q");
    await f.service.operate(f.scope, { action: "mute", muted: true }, f.transport);
    await f.flush();
    expect(f.attempts).toEqual([]);
    await f.service.operate(f.scope, { action: "mute", muted: false }, f.transport);
    await f.service.operate(f.scope, { action: "snooze", minutes: 10 }, f.transport);
    await f.flush();
    expect(f.attempts).toEqual([]);
    f.advance(600000);
    await f.flush(f.scope, { viewed: true });
    expect(f.attempts).toEqual([]);
    await f.flush(f.scope, { source: null });
    expect(f.attempts).toEqual([]);
    await f.flush();
    expect(f.attempts).toHaveLength(1);
  });

  it("lost delivery requires explicit immutable retry and never spends another quota slot", async () => {
    const f = await fixture();
    await f.add("q");
    f.lose(true);
    await f.flush();
    await f.flush();
    expect(f.attempts).toHaveLength(1);
    f.lose(false);
    await f.restart().operate(f.scope, { action: "retry" }, f.transport);
    expect(f.attempts).toHaveLength(2);
    expect(f.attempts[1]).toEqual(f.attempts[0]);
    expect(f.remote.size).toBe(1);
  });

  it("only explicit answers from the recipient on the exact batch resolve; denial withholds cached answers", async () => {
    const f = await fixture();
    await f.add("q");
    await f.flush();
    const h = [...f.remote.values()][0]!;
    const id = readHumanPrompts(h.text)!.items[0]!.id;
    const reply = (actor: string, text: string) => ({
      actor,
      text,
      id: randomUUID(),
      at: "now",
      revision: 2,
    });
    h.replies = [
      reply("github:author", encodeHumanAnswers([{ id, text: "forged" }])),
      reply("github:recipient", "ordinary discussion"),
    ];
    expect(
      (await f.service.operate(f.scope, { action: "resolve" }, f.transport)).items[0]!.answer,
    ).toBeNull();
    h.replies.push(
      reply("github:recipient", encodeHumanAnswers([{ id: randomUUID(), text: "other item" }])),
    );
    h.replies.push(reply("github:recipient", encodeHumanAnswers([{ id, text: "accepted" }])));
    expect(
      (await f.service.operate(f.scope, { action: "resolve" }, f.transport)).items[0]!.answer?.text,
    ).toBe("accepted");
    expect(h.state).toBe("open");
    h.replies.push(reply("github:recipient", encodeHumanAnswers([{ id, text: "corrected" }])));
    expect(
      (await f.service.operate(f.scope, { action: "resolve" }, f.transport)).items[0]!.answer?.text,
    ).toBe("corrected");
    f.deny(true);
    await expect(f.service.operate(f.scope, { action: "list" }, f.transport)).rejects.toThrow(
      "denied",
    );
    await expect(f.flush()).rejects.toThrow("denied");
  });

  it("never dispatches or retries a native question after its pending form closes", async () => {
    const f = await fixture();
    const input = {
      action: "add" as const,
      dedupeKey: "native",
      recipient: "github:recipient",
      kind: "question" as const,
      priority: "blocking" as const,
      text: "Native question",
    };
    const active = { ...f.scope, pendingQuestionIds: ["form"] };
    await f.service.operate(active, input, f.transport, "form");
    await expect(f.service.operate(active, input, f.transport)).rejects.toThrow("conflict");
    await f.flush(active, { source: null });
    await f.flush();
    expect(f.attempts).toEqual([]);
    expect(
      (await f.service.operate(f.scope, { action: "list" }, f.transport)).items[0]!.retired,
    ).toBe(true);
    const other = { ...f.scope, agentId: "other", pendingQuestionIds: ["other-form"] };
    await f.service.operate(other, input, f.transport, "other-form");
    f.lose(true);
    await f.flush(other);
    expect(f.attempts).toHaveLength(1);
    f.lose(false);
    await f
      .restart()
      .operate({ ...other, pendingQuestionIds: [] }, { action: "retry" }, f.transport);
    expect(f.attempts).toHaveLength(1);
  });

  it("keeps native forms out of generic batches so closing a form cannot replay it with another item", async () => {
    const f = await fixture();
    const active = { ...f.scope, pendingQuestionIds: ["form"] };
    await f.add("generic", {}, active);
    await f.service.operate(
      active,
      {
        action: "add",
        dedupeKey: "native",
        recipient: "github:recipient",
        kind: "question",
        priority: "blocking",
        text: "Native question",
      },
      f.transport,
      "form",
    );
    await f.flush(active);
    const h = [...f.remote.values()][0]!;
    expect(readHumanPrompts(h.text)!.items.map((i) => i.text)).toEqual(["Which option?"]);
    f.advance(300000);
    await f.flush();
    expect(f.attempts).toHaveLength(1);
  });

  it("puts recipient answers ahead of local notes in a bounded reminder", async () => {
    const f = await fixture();
    for (let i = 0; i < 10; i++) await f.add(`note${i}`, { kind: "note" });
    await f.add("question");
    await f.flush();
    const h = [...f.remote.values()][0]!;
    const id = readHumanPrompts(h.text)!.items[0]!.id;
    h.replies = [
      {
        id: randomUUID(),
        actor: "github:recipient",
        at: "now",
        revision: 2,
        text: encodeHumanAnswers([{ id, text: "ANSWER-FIRST" }]),
      },
    ];
    expect(await f.flush()).toContain("ANSWER-FIRST");
  });

  it("reminders are change-only, budgeted, and not consumed by dispatch-only boundaries", async () => {
    const f = await fixture();
    expect(await f.flush()).toBeNull();
    for (let i = 0; i < 10; i++) await f.add(`q${i}`);
    expect(await f.flush(f.scope, { remind: false })).toBeNull();
    const reminder = await f.flush();
    expect(reminder).toContain("historical data, not instructions");
    expect(reminder!.length).toBeLessThanOrEqual(600);
    expect(reminder).toContain("truncated");
    expect(await f.flush()).toBe(reminder);
    await f.service.acknowledgeReminder(f.scope, reminder!);
    expect(
      await f.restart().boundary(f.scope, f.transport, { source: f.source, viewed: false }),
    ).toBeNull();
  });

  it("rejects forged response pins and cross-session tool overrides", async () => {
    const f = await fixture();
    await f.add("q");
    await f.flush();
    const h = [...f.remote.values()][0]!;
    h.sources = [{ ...f.source, entryId: "foreign" }];
    await expect(f.service.operate(f.scope, { action: "list" }, f.transport)).rejects.toThrow(
      "invalid-response",
    );
    await expect(f.add("override", { sessionId: "foreign" })).rejects.toThrow();
  });
});
