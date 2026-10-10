import { expect, test } from "vitest";
import { mentionError } from "./mention-errors";
import { isTerminalSyncError } from "./sync-destination";

const SECRET_COPY =
  "A secret was detected in this batch. Sync stopped. Remove or rotate the secret, or keep this session local.";
const SCANNER_COPY =
  "The secret scanner is unavailable on this host. Check the pinned Gitleaks installation, then retry sync.";

test("an uncertain saved send explains retained proof rather than suggesting reconnect", () => {
  expect(mentionError(new Error("agent_request_outcome_unknown"))).toBe(
    "The host could not verify whether this saved message was accepted. Its receipt is retained to prevent a duplicate. Reconnecting alone will not resolve it; recovery requires the original message in the provider's history.",
  );
});

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

test("a scanner deadline offers retry without claiming a missing binary or an uncommitted batch", () => {
  const code = "capture-local-scan-timeout";
  expect(mentionError(new Error(code))).toBe(
    "The secret scan exceeded its deadline. This batch was not sent by the current attempt. Retry sync; earlier attempts or batches may already have committed.",
  );
  expect(isTerminalSyncError(code)).toBe(false);
});

test("a transient failure still suggests a retry, not the secret copy", () => {
  const message = mentionError(new Error("evidence-http-503"));
  expect(message).not.toBe(SECRET_COPY);
  expect(isTerminalSyncError("evidence-http-503")).toBe(false);
});

test("a cut-scan limit explains capacity without claiming a secret was found", () => {
  const code = "capture-local-cut-scan-limit";
  expect(mentionError(new Error(code))).toBe(
    "This batch exceeds the local truncation safety-scan limit. Sync stopped. Keep the session local until the oversized record is resolved.",
  );
  expect(isTerminalSyncError(code)).toBe(true);
});
test.each([
  ["capture-head-diverged", "OpenCode Fork"],
  ["capture-head-diverged", "Removed sources are never recreated automatically"],
  ["capture-recovery-invalid", "Automatic sync stopped"],
  ["chi-operation-timeout", "may already have committed"],
])("%s explains the recovery path", (code, text) => {
  expect(mentionError(new Error(code))).toContain(text);
  expect(isTerminalSyncError(code)).toBe(code !== "chi-operation-timeout");
});
