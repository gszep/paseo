import { expect, test } from "vitest";
import { mentionError } from "./mention-errors";
import { isTerminalSyncError } from "./sync-destination";

const SECRET_COPY =
  "A secret was detected in this batch. Sync stopped. Remove or rotate the secret, or keep this session local.";
const SCANNER_COPY =
  "The secret scanner is unavailable on this host. Check the pinned Gitleaks installation, then retry sync.";

test("deployment inbox readiness is distinct from host or backend capability", () => {
  expect(mentionError(new Error("chi-mentions-http-503-deployment-inbox-not-ready"))).toBe(
    "Deployment-wide Mentions is not ready yet. The operator must complete the inbox migration before mentions can load. Reconnecting this host will not help.",
  );
  expect(mentionError(new Error("chi-deployment-inbox-backend-upgrade-required"))).toContain(
    "backend update",
  );
});

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

test("a drained or unready repository explains setup/maintenance instead of a host reconnect", () => {
  for (const code of [
    "append-http-503-source-writers-drained",
    "chi-mentions-http-503-source-writers-drained",
  ]) {
    const message = mentionError(new Error(code));
    expect(message).toContain("setup or maintenance");
    expect(message).toContain("repository admin or operator");
    expect(message).not.toContain("Reconnect this host and retry");
    // Retryable: the bounded auto-retry resumes once the backend state changes.
    expect(isTerminalSyncError(code)).toBe(false);
  }
});

test("an unknown 503 stays a generic temporary outage, never a reconnect or reset", () => {
  for (const code of [
    "append-http-503",
    "append-http-503-log-commit-unknown",
    "chi-mentions-http-503",
    "chi-mentions-http-503-capacity-contention",
  ]) {
    const message = mentionError(new Error(code));
    expect(message).toContain("temporarily unavailable");
    expect(message).not.toContain("Reconnect this host and retry");
    expect(message).not.toContain("reset");
    expect(isTerminalSyncError(code)).toBe(false);
  }
});

test("an unconfirmed commit never claims the capture was rejected", () => {
  for (const code of ["append-http-503", "append-http-503-log-commit-unknown"]) {
    const message = mentionError(new Error(code));
    expect(message).toMatch(/could not confirm/);
    expect(message).not.toMatch(/did not accept|was rejected|not accepted/);
    // Immutable replay keeps it retryable and duplicate-safe.
    expect(message).toContain("replays the exact same batch");
    expect(isTerminalSyncError(code)).toBe(false);
  }
});

test("a cut-scan limit explains capacity without claiming a secret was found", () => {
  const code = "capture-local-cut-scan-limit";
  expect(mentionError(new Error(code))).toBe(
    "This batch exceeds the local truncation safety-scan limit. Sync stopped. Keep the session local until the oversized record is resolved.",
  );
  expect(isTerminalSyncError(code)).toBe(true);
});
test("an over-cap reasoning record explains the capacity stop without claiming a secret was found", () => {
  const code = "native-capture-bounds";
  expect(mentionError(new Error(code))).toBe(
    "This session has a record too large to keep its reasoning within the shared evidence limit. Sync stopped; start a shorter session or keep this session local.",
  );
  expect(mentionError(new Error(code))).not.toContain("A secret was detected");
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
