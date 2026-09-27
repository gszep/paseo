import { beforeEach, expect, test, vi } from "vitest";

const disk = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
  removeItem: vi.fn<(key: string) => Promise<void>>(),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: disk }));
import { prepareMentionSubmission, completeMentionSubmission } from "./mention-submission";

beforeEach(() => {
  disk.values.clear();
  disk.getItem.mockReset().mockImplementation(async (key) => disk.values.get(key) ?? null);
  disk.setItem.mockReset().mockImplementation(async (key, value) => {
    disk.values.set(key, value);
  });
  disk.removeItem.mockReset().mockImplementation(async (key) => {
    disk.values.delete(key);
  });
});

test("an uncertain send restores recipients and the same native submission identity", async () => {
  const first = await prepareMentionSubmission("host", "agent", "@recipient check", [
    "github:recipient",
  ]);
  expect(first?.messageId).toBeTruthy();
  expect(await prepareMentionSubmission("host", "agent", "@recipient check", [])).toEqual(first);
  expect(await prepareMentionSubmission("other-host", "agent", "@recipient check", [])).toBeNull();
  await completeMentionSubmission("host", "agent");
  expect(await prepareMentionSubmission("host", "agent", "@recipient check", [])).toBeNull();
});

test("mention storage failures fail before dispatch while ordinary sends remain available", async () => {
  disk.getItem.mockRejectedValue(new Error("storage unavailable"));
  await expect(
    prepareMentionSubmission("host", "agent", "ordinary prompt", []),
  ).resolves.toBeNull();
  await expect(
    prepareMentionSubmission("host", "agent", "@recipient check", ["github:recipient"]),
  ).rejects.toThrow("storage unavailable");
});

test("cleanup failure never reclassifies an accepted native send as failed", async () => {
  disk.removeItem.mockRejectedValue(new Error("storage unavailable"));
  await expect(completeMentionSubmission("host", "agent")).resolves.toBeUndefined();
});
