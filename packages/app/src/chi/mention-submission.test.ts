import { expect, test } from "vitest";
import { createMentionSubmissions, type MentionSubmission } from "./mention-submission";
import { clearMentionSelection, selectMention, selectedRecipients } from "./mention-selection";
import type { ComposerSendClient } from "@/composer/actions";

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
