import { expect, test } from "vitest";
import { mentionError } from "./mention-errors";
import { isTerminalSecretError } from "./sync-destination";

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
    expect(isTerminalSecretError(code)).toBe(true);
  },
);

test("maps a missing local scanner to the host-dependency copy", () => {
  const message = mentionError(new Error("capture-local-scanner-unavailable"));
  expect(message).toBe(SCANNER_COPY);
  expect(message).not.toContain("Reconnect");
  expect(isTerminalSecretError("capture-local-scanner-unavailable")).toBe(true);
});

test("a transient failure still suggests a retry, not the secret copy", () => {
  const message = mentionError(new Error("evidence-http-503"));
  expect(message).not.toBe(SECRET_COPY);
  expect(isTerminalSecretError("evidence-http-503")).toBe(false);
});
