import type { ChiFailure } from "@getpaseo/protocol/chi-mentions";
import { ChiOperationError } from "@getpaseo/protocol/chi-mentions";

// Codes are produced by the host login/repository boundary and fixed Chi routes.
const accessFailures = new Set([
  "chi-destination-required",
  "chi-destination-changed",
  "chi-github-login-required",
  "chi-identity-mismatch",
  "chi-repository-mismatch",
  "chi-repository-denied",
  "chi-mention-context-changed",
  "chi-workspace-unavailable",
  "chi-http-401",
  "chi-http-403",
  "chi-http-404",
  "chi-mentions-http-401",
  "chi-mentions-http-403",
  "chi-mentions-http-404",
]);

export function classifyMentionFailure(error: unknown): ChiFailure {
  if (error instanceof ChiOperationError && error.failure) return error.failure;
  const code = error instanceof Error ? error.message : "";
  return {
    accessLost: accessFailures.has(code),
    // These fixed-route responses prove that the submitted revision did not commit.
    // Auth loss can occur on the post-mutation recheck, so it proves no such thing.
    outcome: ["chi-mentions-http-409", "chi-mentions-http-422", "chi-mentions-http-413"].includes(
      code,
    )
      ? "not_committed"
      : "unknown",
  };
}
