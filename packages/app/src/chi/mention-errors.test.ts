import { expect, test } from "vitest";
import { mentionError } from "./mention-errors";
import { isTerminalSyncError } from "./sync-destination";

const SECRET_COPY =
  "A secret was detected in this session's history. Nothing was uploaded. Remove or rotate the secret, or keep this session local.";
const SCANNER_COPY =
  "The secret scanner is unavailable on this host, so nothing was uploaded. Install gitleaks on the host to sync this session.";

test.each(["capture-local-secret-rejected", "evidence-http-422-server-secret-scan-rejected"])(
  "maps %s to the honest secret copy",
  (code) => {
    const message = mentionError(new Error(code));
    expect(message).toBe(SECRET_COPY);
    expect(message).not.toContain("Reconnect");
    expect(isTerminalSyncError(code)).toBe(true);
  },
);

test("maps a missing local scanner to the host-dependency copy", () => {
  const message = mentionError(new Error("capture-local-scanner-unavailable"));
  expect(message).toBe(SCANNER_COPY);
  expect(message).not.toContain("Reconnect");
  // Retryable: installing gitleaks and retrying can succeed.
  expect(isTerminalSyncError("capture-local-scanner-unavailable")).toBe(false);
});

test("a transient failure still suggests a retry, not the secret copy", () => {
  const message = mentionError(new Error("evidence-http-503"));
  expect(message).not.toBe(SECRET_COPY);
  expect(isTerminalSyncError("evidence-http-503")).toBe(false);
});

test("a cut-scan limit explains capacity without claiming a secret was found", () => {
  const code = "capture-local-cut-scan-limit";
  expect(mentionError(new Error(code))).toBe(
    "This session exceeds the local truncation safety-scan limit. Nothing was uploaded. Start a shorter session or keep this session local.",
  );
  expect(isTerminalSyncError(code)).toBe(true);
});
