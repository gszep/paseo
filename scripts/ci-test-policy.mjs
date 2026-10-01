// These are test/harness contracts, not a second production dependency map.
// Production edges are derived in ci-selection.mjs on every tested merge tree.
export const suites = {
  server: ["server"],
  app: ["app"],
  sdk: ["protocol", "client", "plugin", "highlight"],
  relay: ["relay"],
  cli: ["cli", "server"],
  // The harness starts real processes; imports alone cannot describe these edges.
  browser: ["app", "server"],
  desktop: ["desktop", "app", "server", "cli"],
};

export const critical = {
  server: [
    "src/server/auth.test.ts",
    "src/server/bootstrap-auth.test.ts",
    "src/server/config-auth.test.ts",
    "src/server/agent/permission-response.test.ts",
    "src/server/agent/agent-manager.test.ts",
    "src/server/chi/connection.test.ts",
    "src/server/chi/destinations.test.ts",
    "src/server/chi/mentions.test.ts",
    "src/server/chi/provenance.test.ts",
    "src/server/message-receipts/index.test.ts",
  ],
  app: [
    "src/utils/scanned-pairing-offer.test.ts",
    "src/chi/continuation-state.test.ts",
    "src/chi/entry-navigation.test.ts",
    "src/chi/mention-submission.test.ts",
    "src/chi/mention-context.test.ts",
    "src/chi/mention-errors.test.ts",
    "src/chi/reply-model.test.ts",
    "src/chi/inbox-model.test.ts",
    "src/chi/inbox-query.test.ts",
    "src/chi/mentions-unavailable.browser.test.tsx",
    "src/chi/repository-filter.browser.test.tsx",
    "src/chi/sync-notice.browser.test.tsx",
    "src/chi/use-sync-destination.browser.test.tsx",
    "src/composer/actions.test.ts",
    "src/runtime/host-runtime.test.ts",
  ],
  client: ["src/daemon-client.test.ts"],
};

// Directories whose entire unit-test inventory is an always-run floor. Every
// *.test.ts(x) below must appear in `critical` (or in `criticalExemptions` with
// a reason), so a new sibling test cannot silently fall outside the floor. The
// coverage guard lives in scripts/ci-selection.test.mjs.
export const criticalDirectories = {
  app: ["src/chi"],
  server: ["src/server/chi", "src/server/message-receipts"],
};

// Deliberate exceptions to `criticalDirectories`, keyed by repo-relative path.
// Each value is the reason the test is not part of the always-run floor.
export const criticalExemptions = {
  // "packages/app/src/chi/example.test.ts": "reason",
};

// This regression is not part of the old server test:integration allowlist.
// Run it explicitly on BOTH selected and full paths.
export const criticalServerIntegration = ["src/server/daemon-e2e/agent-rpc-durability.e2e.test.ts"];

export const criticalCli = [
  "12-permit-ls.test.ts",
  "13-permit-allow-deny.test.ts",
  "32-daemon-set-password.test.ts",
  "34-daemon-status-auth.test.ts",
];
