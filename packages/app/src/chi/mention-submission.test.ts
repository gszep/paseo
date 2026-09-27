import { expect, test } from "vitest";
import { createMentionSubmissions, type MentionSubmission } from "./mention-submission";
import { clearMentionSelection, selectMention, selectedRecipients } from "./mention-selection";
import type { ComposerSendClient } from "@/composer/actions";
import { ChiOperationError } from "@getpaseo/protocol/chi-mentions";

const context = { actor: "github:sender", repo: "github:fixture/repo", generation: "a".repeat(64) };
const request: MentionSubmission = {
  agentId: "agent",
  messageId: "message",
  text: "@recipient check",
  chiMentions: ["github:recipient"],
  chiMentionContext: context,
  activeTurnBehavior: "interrupt",
  images: [],
  attachments: [],
};
function disk() {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
}
function sender(calls: MentionSubmission[]): ComposerSendClient {
  return {
    sendAgentMessage: async (agentId, text, options) => {
      calls.push({ agentId, text, ...options });
    },
    uploadFile: async () => {
      throw new Error("unused");
    },
  };
}

test("Clear never restores hidden recipients by text equality; only explicit saved-send retry replays them", async () => {
  const storage = disk();
  const sends = createMentionSubmissions(storage);
  selectMention("host", "agent", { ownerId: "github:recipient", handle: "recipient", context });
  await sends.prepare("host", request);
  clearMentionSelection("host", "agent");
  expect(selectedRecipients("host", "agent", request.text)).toEqual([]);
  const fresh = {
    ...request,
    messageId: "new-message",
    chiMentions: undefined,
    chiMentionContext: undefined,
  };
  await expect(sends.prepare("host", fresh)).rejects.toThrow("chi-mention-submission-unresolved");
  expect(selectedRecipients("host", "agent", request.text)).toEqual([]);
  const calls: MentionSubmission[] = [];
  await createMentionSubmissions(storage).retry("host", "agent", context, sender(calls));
  expect(calls).toEqual([request]);
  expect(await sends.read("host", "agent")).toBeNull();
  await sends.prepare("host", fresh);
  expect(await sends.read("host", "agent")).toBeNull();
});

test("immutable admission includes identity, behavior, attachments and images, and copies caller input", async () => {
  const sends = createMentionSubmissions(disk());
  const original = structuredClone(request);
  await sends.prepare("host", original);
  original.chiMentions!.push("github:other");
  original.chiMentionContext!.repo = "github:other/repo";
  expect(await sends.read("host", "agent")).toEqual(request);
  for (const change of [
    { messageId: "new-id" },
    { activeTurnBehavior: "steer" as const },
    { images: [{ data: "aGVsbG8=", mimeType: "image/png" }] },
    {
      attachments: [
        { type: "text" as const, mimeType: "text/plain" as const, text: "skill expansion" },
      ],
    },
    { chiMentionContext: { ...context, generation: "b".repeat(64) } },
  ])
    await expect(sends.prepare("host", { ...request, ...change })).rejects.toThrow();
  await sends.prepare("host", request);
  expect(await sends.read("other-host", "agent")).toBeNull();
});

test("concurrent prepares cannot overwrite the one unresolved request", async () => {
  const sends = createMentionSubmissions(disk());
  const results = await Promise.allSettled([
    sends.prepare("host", request),
    sends.prepare("host", { ...request, messageId: "other" }),
  ]);
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(await sends.read("host", "agent")).toEqual(request);
});

test("unreadable storage blocks a replacement; changed authority cannot replay saved content", async () => {
  const storage = disk();
  const sends = createMentionSubmissions(storage);
  await sends.prepare("host", request);
  const calls: MentionSubmission[] = [];
  await expect(
    sends.retry("host", "agent", { ...context, actor: "github:other" }, sender(calls)),
  ).rejects.toThrow("chi-mention-context-changed");
  const blocked = createMentionSubmissions({
    ...storage,
    getItem: async () => {
      throw new Error("restore failed");
    },
  });
  await expect(blocked.prepare("host", { ...request, messageId: "new" })).rejects.toThrow(
    "restore failed",
  );
  expect(calls).toEqual([]);
  expect(await sends.read("host", "agent")).toEqual(request);
});

test("cleanup failure never reclassifies an accepted send as failed", async () => {
  const sends = createMentionSubmissions({
    ...disk(),
    removeItem: async () => {
      throw new Error("storage unavailable");
    },
  });
  await sends.prepare("host", request);
  const calls: MentionSubmission[] = [];
  await sends.retry("host", "agent", context, sender(calls));
  expect(calls).toEqual([request]);
  expect(await sends.read("host", "agent")).toEqual(request);
});

test("late completion of an old retry cannot erase a newer unresolved send", async () => {
  const sends = createMentionSubmissions(disk());
  await sends.prepare("host", request);
  await sends.complete("host", "agent", "message");
  const next = { ...request, messageId: "next" };
  await sends.prepare("host", next);
  await sends.complete("host", "agent", "message");
  expect(await sends.read("host", "agent")).toEqual(next);
});

test("length validation precedes persistence, and proven non-admission permits corrected or ordinary sends", async () => {
  const storage = disk();
  const sends = createMentionSubmissions(storage);
  await expect(sends.prepare("host", { ...request, text: "x".repeat(8001) })).rejects.toThrow(
    "chi-mention-text-too-long",
  );
  expect(await sends.read("host", "agent")).toBeNull();
  await sends.prepare("host", request);
  const attempt = await sends.beginAttempt("host", request);
  await sends.reject("host", "agent", "message", new Error("chi-share-required"), attempt);
  expect(await sends.read("host", "agent")).toEqual(request);
  await sends.reject(
    "host",
    "agent",
    "message",
    new ChiOperationError("chi-share-required", { accessLost: false, outcome: "not_committed" }),
    attempt,
  );
  expect(await sends.read("host", "agent")).toBeNull();
  await sends.prepare("host", { ...request, messageId: "corrected", text: "@recipient corrected" });
  await sends.complete("host", "agent", "corrected");
  await sends.prepare("host", { agentId: "agent", text: "ordinary", messageId: "ordinary" });
  expect(await sends.read("host", "agent")).toBeNull();
});

test("saved-send retry only releases a proven non-admission, retaining timeouts and ambiguous provider outcomes", async () => {
  const sends = createMentionSubmissions(disk());
  await sends.prepare("host", request);
  const client = sender([]);
  for (const error of [
    new Error("timeout"),
    new ChiOperationError("agent_request_outcome_unknown", {
      accessLost: false,
      outcome: "unknown",
    }),
  ]) {
    client.sendAgentMessage = async () => {
      throw error;
    };
    await expect(sends.retry("host", "agent", context, client)).rejects.toThrow(error.message);
    expect(await sends.read("host", "agent")).toEqual(request);
  }
  client.sendAgentMessage = async () => {
    throw new ChiOperationError("chi-mention-recipient-unavailable", {
      accessLost: false,
      outcome: "not_committed",
    });
  };
  await expect(sends.retry("host", "agent", context, client)).rejects.toThrow(
    "chi-mention-recipient-unavailable",
  );
  expect(await sends.read("host", "agent")).toBeNull();
});

test("separate store instances serialize admission and late rejection cleanup", async () => {
  const storage = disk();
  const first = createMentionSubmissions(storage),
    second = createMentionSubmissions(storage);
  const outcomes = await Promise.allSettled([
    first.prepare("host", request),
    second.prepare("host", { ...request, messageId: "other" }),
  ]);
  expect(outcomes.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  const attempt = await first.beginAttempt("host", request);
  await first.complete("host", "agent", "message");
  await second.prepare("host", { ...request, messageId: "other" });
  await first.reject(
    "host",
    "agent",
    "message",
    new ChiOperationError("rejected", { accessLost: false, outcome: "not_committed" }),
    attempt,
  );
  expect((await second.read("host", "agent"))?.messageId).toBe("other");
});

test("late non-admission cannot erase a newer attempt of the same immutable send, even after clearing and resaving", async () => {
  const sends = createMentionSubmissions(disk());
  const rejection = new ChiOperationError("chi-share-required", {
    accessLost: false,
    outcome: "not_committed",
  });
  await sends.prepare("host", request);
  const a = await sends.beginAttempt("host", request);
  const b = await sends.beginAttempt("host", request);
  await sends.reject("host", "agent", "message", rejection, a);
  expect(await sends.read("host", "agent")).toEqual(request);
  await sends.reject("host", "agent", "message", rejection, b);
  expect(await sends.read("host", "agent")).toBeNull();
  await sends.prepare("host", request);
  const c = await sends.beginAttempt("host", request);
  expect(c).not.toBe(a);
  await sends.reject("host", "agent", "message", rejection, a);
  expect(await sends.read("host", "agent")).toEqual(request);
  const rotated = { ...context, generation: "b".repeat(64) };
  await sends.reauthorize("host", "agent", rotated);
  await sends.reject("host", "agent", "message", rejection, c);
  expect(await sends.read("host", "agent")).toEqual({
    ...request,
    chiMentionAuthorization: rotated,
  });
  await expect(sends.beginAttempt("host", request)).rejects.toThrow(
    "chi-mention-submission-unresolved",
  );
});

test("same-account credential rotation explicitly reauthorizes without changing the immutable request", async () => {
  const sends = createMentionSubmissions(disk());
  await sends.prepare("host", request);
  const calls: MentionSubmission[] = [];
  const rotated = { ...context, generation: "b".repeat(64) };
  await expect(sends.retry("host", "agent", rotated, sender(calls))).rejects.toThrow(
    "chi-mention-context-changed",
  );
  await expect(
    sends.reauthorize("host", "agent", { ...rotated, actor: "github:other" }),
  ).rejects.toThrow("chi-mention-context-changed");
  await expect(
    sends.reauthorize("host", "agent", { ...rotated, repo: "github:other/repo" }),
  ).rejects.toThrow("chi-mention-context-changed");
  expect(await sends.read("host", "agent")).toEqual(request);
  await sends.reauthorize("host", "agent", rotated);
  await sends.retry("host", "agent", rotated, sender(calls));
  expect(calls).toEqual([{ ...request, chiMentionAuthorization: rotated }]);
});
