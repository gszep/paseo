import { expect, test } from "vitest";

import { friendlyComposerSendError } from "./send-error";

test("maps host_restarting to retryable copy", () => {
  expect(friendlyComposerSendError(new Error("host_restarting"))).toContain("restarting");
});

test("keeps mention copy for chi-prefixed errors and passes through others", () => {
  expect(friendlyComposerSendError(new Error("chi-host-disconnected"))).toContain("Reconnect");
  expect(friendlyComposerSendError(new Error("boom"))).toBe("boom");
});
