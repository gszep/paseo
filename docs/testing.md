# Testing

## Philosophy

Tests prove behavior, not structure. Every test should answer: "what user-visible or API-visible behavior does this verify?"

## Test-driven development

Work in vertical slices: one test, one implementation, repeat. Each test responds to what you learned from the previous cycle.

```
RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3

WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5
```

Writing all tests first then all implementation produces bad tests — you end up testing imagined behavior instead of actual behavior.

## Fallible user actions

Every user action that can fail must expose the complete operation state in the UI:

- **Pending:** show immediate progress and prevent accidental duplicate submissions.
- **Success:** show the requested result, or a clear success acknowledgement when the result is not otherwise visible.
- **Failure:** keep an actionable error visible in the same context until the user retries or dismisses it.

Logs, console output, and a reset button are not user feedback. Neither is a platform API unless it is verified on every supported platform: React Native Web's `Alert.alert()` is a no-op, so browser and Electron failures must use rendered app UI such as the shared alert component.

Every fallible action needs behavioral coverage for success and failure. RPC-backed UI should use an app Playwright test with a real browser, network, and daemon whenever feasible. The failure test must assert what the user can see and do after the failure, not an internal response, state field, or log line. Add distinct timeout or disconnect cases when they produce distinct recovery behavior.

## Determinism first

Tests must produce the same result every run:

- No conditional assertions or branching paths
- No reliance on timing, randomness, or network jitter
- No weak assertions (`toBeTruthy`, `toBeDefined`)
- Assert the full intended behavior, not fragments

```typescript
// Bad: conditional and weak
it("creates a tool call", async () => {
  const result = await createToolCall(input);
  if (result.ok) {
    expect(result.id).toBeDefined();
  }
});

// Good: deterministic and explicit
it("returns timeout error when provider times out", async () => {
  const result = await createToolCall(input);
  expect(result).toEqual({
    ok: false,
    error: { code: "PROVIDER_TIMEOUT", waitedMs: 30000 },
  });
});
```

## Flaky tests are a bug

Never remove a test because it's flaky. Find the variance source (time, randomness, race condition, shared state, non-deterministic output, environment drift) and fix it.

## CI fast paths

All 17 required contexts remain present. Draft PRs and changes containing only
untested Markdown skip unrelated jobs at job level; critical contracts still run.
Changelogs, public documentation
read by tests, and runtime skills keep their tests. HTML and SVG are not
Markdown-only changes. Classification errors run the full matrix; main pushes
and non-PR runs never use the docs-only skip.

Only successful main jobs write dependency/build snapshots. PRs restore the
latest compatible immutable SHA snapshot, keeping the previous main snapshot
available while its replacement uploads. Installed trees require the exact
runner image, architecture, Node/ABI, npm, lockfile, workspace manifests, vendor
and lifecycle inputs; invalid stamps, versions, patches or workspace links fall
back to the frozen installer. Build archives are candidates, not proof of a
valid build: each task verifies its transitive inputs and output bytes before
reusing it. A miss removes old outputs and runs the existing npm build command.

Cache timings must distinguish cold install/build, archive transfer, validated
hits and changed-source misses. A PR cannot seed the main cache, so the first
warm measurement requires a successful main run after merge.

## Real dependencies over mocks

Mocks are not the default. They require an explicit decision.

- **Database**: real test database, not a mock
- **APIs**: real APIs with test/sandbox credentials, not request mocks
- **File system**: temporary directory that gets cleaned up, not fs mocks

Ask: "will this still hold with real dependencies at runtime?" If no, don't mock.

### Use swappable adapters instead

When you need test isolation, design code so dependencies are injectable:

```typescript
interface EmailSender {
  send(to: string, body: string): Promise<void>;
}

// Production
const realSender: EmailSender = { send: sendgrid.send };

// Test: in-memory adapter
function createTestEmailSender() {
  const sent: Array<{ to: string; body: string }> = [];
  return {
    send: async (to: string, body: string) => {
      sent.push({ to, body });
    },
    sent,
  };
}
```

## End-to-end means end-to-end

When a test is labeled end-to-end, it calls the real service. No environment variable gates, no conditional skipping, no mocking the external dependency.

### Packaged desktop smoke

The packaged desktop smoke is an external observer of the production launch path. It must not add a smoke-only branch to Electron main or start the daemon itself.

The harness launches the packaged app with isolated user data and daemon state, connects to the real renderer over Chromium's debugging protocol, and requires all of these outcomes:

- the `paseo://app/` renderer mounts into `#root`;
- the sandboxed preload exposes the desktop bridge;
- the renderer starts a fresh desktop-managed daemon through the normal startup bootstrap;
- the bundled CLI can query that daemon and run a terminal command.

The Desktop Packages workflow runs the Linux x64 smoke under Xvfb on main pushes and on pull requests that change `packages/desktop/**`, `nix/**`, or the workflow itself. The Linux job is pinned to Ubuntu 24.04 and runs twice: with AppArmor user namespace restrictions enabled, then with user namespaces available. It installs the real `.deb`, launches the real AppImage via `--appimage-extract-and-run`, and launches the extracted tar archive. It also replaces the Debian installation with the generated RPM through `rpm --install --nodeps` and checks its sandboxed launch under restrictions. Ubuntu supplies the runtime libraries under Debian package names, so this verifies the RPM payload and postinstall rather than Fedora dependency resolution. Each launch verifies the reported sandbox decision; enabled renderers must also have `NoNewPrivs: 1` and `Seccomp: 2` in `/proc`. The desktop release matrix retains its host-native smokes. Linux release builds stay on Ubuntu 22.04 to preserve their native-library baseline; the restricted-host regression runs on Ubuntu 24.04 after merge.

Never repair `chrome-sandbox` in the smoke harness. The old unpacked smoke set its mode to 4755 and concealed a broken package installer. Run installer tests as root and launch tests as an ordinary user: a root-run namespace probe does not reproduce Ubuntu's AppArmor policy for desktop users. Preserve both restricted and unrestricted cases; either one alone permits another sandbox regression.

Smoke jobs upload renderer screenshots and desktop/daemon diagnostics, including successful Linux sandbox evidence.

To exercise the smoke locally on Linux:

```bash
PASEO_DESKTOP_SMOKE=1 \
PASEO_DESKTOP_SMOKE_ARTIFACT_DIR=/tmp/paseo-desktop-smoke \
npm run build:desktop -- --publish never --linux --x64 --dir
```

### Undeclared peer dependencies break app.asar

electron-builder packs `node_modules` by walking declared production `dependencies`. A package that imports something it only lists as a `peerDependency` resolves fine in this hoisted workspace, passes every test, and then throws `ERR_MODULE_NOT_FOUND` inside `app.asar` — killing the desktop daemon at startup. That shipped twice from `@replit/codemirror-lang-*` grammars, which are interactive editor extensions published as if they were bare parsers.

The packaged smoke catches it after merge. PRs need the fast dependency-closure test below because packaging runs on main.

`packages/highlight/src/__tests__/dependency-closure.test.ts` replicates the packer's traversal statically and runs with the normal unit tests. It is scoped to `@getpaseo/highlight` on purpose: that tree is small and pure, so the check is exact. Running the same walk over `@getpaseo/server` produces dozens of false positives from optional dependencies loaded behind `try`/`catch`.

Prefer a `@lezer/*` grammar. When a language only ships inside an editor extension, vendor the grammar into `packages/highlight/src/<lang>/` — see `svelte/`, `nix/`, and `csharp/`.

### Desktop browser regression

The desktop browser E2E launches an isolated real daemon, Metro, and Electron app. It forces workspace LRU eviction to reparent the original tab and replace its guest `WebContents`, then makes one MCP call each for tab listing, snapshot, and click against that original browser id. A final MCP wait proves the real target page received the click.

Run it locally with the same command owned by the Ubuntu `desktop-tests` required check:

```bash
npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop
```

## Test organization

- Collocate tests with implementation: `thing.ts` + `thing.test.ts`
- Extract complex setup into reusable helpers
- Test bodies should read like plain English
- Build a vocabulary of test helpers that make complex flows simple

### File naming

Vitest picks up tests by suffix. The suffix tells the runner which category it belongs to.

| Suffix                | What it is                                                                                                    | Where it runs                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `*.test.ts(x)`        | Unit test — pure, fast, no daemon                                                                             | `npm run test:unit`                                                                  |
| `*.posix.test.ts`     | Unit test that needs POSIX-only behavior                                                                      | unit, skipped on Windows                                                             |
| `*.browser.test.ts`   | App test that needs a real browser (DOM)                                                                      | `npm run test:browser` (Vitest browser mode, Playwright provider, headless Chromium) |
| `*.e2e.test.ts`       | End-to-end against a real daemon                                                                              | `npm run test:e2e`                                                                   |
| `*.real.e2e.test.ts`  | E2E that hits a real provider (Claude/Codex/Copilot/OpenCode/Pi) — needs creds in `packages/server/.env.test` | `npm run test:integration:real` / `test:e2e:real`                                    |
| `*.local.e2e.test.ts` | E2E that needs a local-only resource                                                                          | `npm run test:integration:local` / `test:e2e:local`                                  |

Browser Playwright specs live in `packages/app/e2e/browser/`. Desktop Playwright and real-Electron E2E live in `packages/desktop/e2e/`. Harness code shared by both suites lives in `packages/app/e2e/support/`; neither suite may place specs there. App Playwright specs that hit real providers use `*.real.spec.ts` and run through `npm run test:e2e:real --workspace=@getpaseo/app`; the default browser project ignores that suffix so CI does not need provider credentials.

`chi-mentions.real.spec.ts` uses the deployed Chi backend and the Sava/Mochi test
accounts in `gszep/chi-synthetic-two-actor-20260925`. Set
`CHI_MENTION_TEST_ACTORS_DIR` to the private directory containing
`sava-the-owl.chi-token` and `mochi-the-kitty.chi-token` (read in-process only).
From the repository root, run:

```sh
CHI_MENTION_TEST_ACTORS_DIR=/absolute/private/actor-directory \
  npm run test:e2e:real --workspace=@getpaseo/app -- e2e/browser/chi-mentions.real.spec.ts --workers=1
```

It refuses CI, starts Metro on a dynamic port and two isolated daemons, and uses a
unique run marker in the synthetic title, question and exact-name inbox locators.
At startup the fixture collects all evidence pages and purges only sources owned
by its test actor with the `Synthetic human mention acceptance` title prefix;
completion purges the current run's captured sources too. Run this shared-account
fixture serially so startup cleanup cannot delete another active acceptance run.
Its provider is synthetic:
this checks rendered desktop/compact Tab completion and mention delivery, exact/context reads,
acknowledgement, lost-response retries, an actual Sava author reply observed by
Mochi at revision 4, and access revocation,
without model calls. It does not establish production installation, native
provider capture or another person's paired-host setup. The spec uses **Share to
Chi**, **Send message**, **Retry mentions**, **Open mentions**, **Read exact source
1**, **Browse pinned context**, **Acknowledge**, **Reply to mention**, **Retry saved
operation** and **Refresh** accessible locators. Source denial must remove the
entire protected scope and show **Mention context unavailable**. Screenshots and
failure traces go to the usual app `test-results` directory. Scope candidate locators
to `composer-autocomplete-popover`: an uncontrolled textarea can retain a completed
handle as its DOM text content after its current value changes.

Deterministic coverage lives in `chi/mention-submission.test.ts`,
`chi/reply-model.test.ts`, `chi/mention-context.test.ts`, `composer/actions.test.ts`
and the queue cases in `runtime/host-runtime.test.ts` in the app; the client's
`daemon-client.test.ts`; and server `chi/mentions.test.ts`, `chi/connection.test.ts`
and `daemon-e2e/agent-rpc-durability.e2e.test.ts`. These cover immutable queued
requests, Clear versus explicit retry, lost-response plus failed restore, shared
cache clearing/delayed reads, expected authority, the actual old-host send gate,
and a real isolated daemon rejecting mention intent on an already-admitted plain
message ID. Transformation rejection is checked before admission, with the same
ID still available to an ordinary send. These suites make no model calls.
Reply regressions exercise the closed-A/remount/committed-B/lost-response race,
oversize validation and persisted scanner rejection followed by explicit correction.
Both send and reply regressions reject stale non-commit responses from older attempts.
Send regressions distinguish proven non-admission from ambiguous outcomes and
exercise explicit same-principal credential rotation. `message-receipts/index.test.ts`
and `chi/mentions.test.ts` check durable admission and restart at the intent-publication
boundary; the latter also checks fixture cleanup ownership/pagination. Mutation
logout coverage uses the production `chi-github-login-required` code and verifies
structured client decoding plus parent/child cache clearing. The real-account
rendered spec remains a separate release gate; deterministic tests do not satisfy it.

Live provider smoke tests belong in `*.real.e2e.test.ts`, not `*.test.ts`, even when guarded by environment variables. Default unit suites must use deterministic provider adapters/fakes so missing credits, auth outages, and upstream model drift do not block normal CI.

Codex MultiAgentV2 real tests use local Codex authentication rather than the OpenRouter-compatible test provider. OpenRouter does not accept Codex collaboration-history items on the parent follow-up request, so it cannot verify a complete native sub-agent turn.

### Test setup

- Server: `packages/server/src/test-utils/vitest-setup.ts` loads `.env.test`, sets `PASEO_SUPERVISED=0`, and disables Git/SSH prompts. Add new global env shims here, not in individual tests.
- App: `packages/app/vitest.setup.ts` provides `expo`/`__DEV__` shims and stubs a few native-only modules (`react-native-unistyles`, `react-native-svg`, `expo-linking`, `@xterm/addon-ligatures`). Stubbing here is for modules that have no meaningful Node behavior — not a license to mock app code.

## Running tests locally

Test suites in this repo are heavy. Running them in bulk freezes the machine, especially with multiple agents in parallel.

- Run only the file you changed: `npx vitest run <path> --bail=1`
- Never run `npm run test` for a whole workspace unless asked.
- For a broad sweep, redirect to a file and read it after: `npx vitest run <path> --bail=1 > /tmp/test-output.txt 2>&1`
- Never re-run a suite another agent already reported green.
- For full-suite confidence, push to CI and check GitHub Actions.
- Never run the full Playwright E2E suite locally — defer whole-suite verification to CI. Targeted Playwright specs are allowed when you changed or need to prove that specific flow.
- App Playwright shares one warmed Metro server per run and gives every Playwright worker its own isolated daemon and `PASEO_HOME`. Spec files run concurrently without exposing one file's projects, agents, terminals, history, or provider configuration to another worker; tests within a file remain together so file-level setup is not repeated.
- Playwright specs that exercise only the daemon import `daemonTest` from the shared fixtures so they do not create a browser context or page.
- Helpers that create projects or workspaces own those records until cleanup. Their clients remove the daemon project on close, and an automatic fixture fails any test that still leaks a project record. Deleting only the temporary directory is not cleanup. Agent helpers pass the intended `workspaceId` through to agent creation; they never infer ownership from `cwd`.
- Tests whose subject is daemon-global state, such as an empty history or daemon restart, start a dedicated host explicitly. Filenames and directories describe product behavior, never execution order or isolation mechanics.
- Global setup accepts Metro as ready only when `/status` returns `packager-status:running`, then fetches the document's scripts so the cold bundle compilation finishes before Playwright's per-test timeout starts. A generic TCP listener is not sufficient readiness evidence. The browser suite uses direct local daemon connections and does not start a relay.
- The app Playwright harness boots on Windows as well as POSIX. Spawn Node entrypoints through `process.execPath`, not `npx` or `node_modules/.bin` shims: Node refuses to spawn `.cmd` or `.bat` without `shell: true`, and shell mode concatenates argv without escaping and sends kill signals to `cmd.exe` instead of the real child.
- Teardown kills the process tree, because a Windows signal reaches only the direct child and leaves forked workers holding the listening port.
- The `asdf`-backed local Elixir relay stays POSIX-only, so the `relay-deployment` Playwright project is unavailable on Windows.

## Pull-request test routing

PR selection follows the dependency cone of the base-to-tested-merge-tree diff.
Workspace manifests, compiler-resolved imports, exports, references and aliases
provide production edges. Platform implementations are unioned: web, native,
Electron, iOS and Android changes cannot hide behind the runner's platform.
`scripts/ci-test-policy.mjs` owns the cross-process harness edges and explicit
critical inventory. Review that inventory when moving or adding security tests.

Required matrix legs are declared as statically named jobs. Their shared steps use YAML anchors, while job-level `if` conditions let GitHub report an unaffected leg as genuinely skipped without allocating a runner or losing the exact required-check name.

Critical Chi capture/scan/minimisation/provenance, auth and mention contracts are
unioned with related unit files before invoking the runner. Never combine a
critical file filter with `--changed` or `--related`: that intersects the sets.
The runner also checks Vitest's actual file collection: an existing critical
path excluded by project configuration fails the check. A unit failure does not
prevent later critical integration commands from running; failures are aggregated.
The server admission/durability integration regression runs explicitly because
the pre-existing integration allowlist did not include it. The CLI runner unions
its permission/auth contracts before creating disjoint shards; an empty shard
succeeds inside its existing job.

Static imports cannot establish independence for process, network, filesystem,
computed-loader or unresolved-module tests. Keep those tests in affected packages.
App browser-unit setup starts a real daemon, and app/desktop E2E starts both the
daemon and renderer. These are explicit harness edges. Browser reachability is
not yet fine-grained, so an affected browser boundary retains every spec across
the four existing shards. Broad UI/server changes can still take the full-run
time; selected-file counts alone are not a speed measurement.

New paths, deletions/renames, unknown inputs, helpers, fixtures, configuration,
scripts, lockfiles, vendored tarballs, graph errors and stale critical paths run
everything. Missing classifier outputs also force every downstream runner full.
Main pushes, nightly, queue and manual runs use the full matrix, including
Windows. Recency never removes a test. The existing draft/untested-Markdown
job-level skip applies only to jobs without critical contracts.

`node --test scripts/ci-selection.test.mjs scripts/ci-workflow.test.mjs` checks
the real-tree change matrix, related-file resolution, critical union, runtime
fallbacks and required contexts. CI logs the selected paths and reason. Validate
the final PR head with a completed full run, and record elapsed Actions time
separately from job execution time when comparing a selected run.

## Agent authentication in tests

Agent providers handle their own auth. Do not add auth checks, environment variable gates, or conditional skips to tests. If auth fails, report it.

## Debugging with tests

Use the test as your debugging ground:

1. Add temporary logging to the code under test
2. Run the test, observe actual values
3. Trace the flow end-to-end through test output
4. Confirm each assumption with actual output
5. Remove logging when done

The test output is the source of truth, not your reading of the code.

## Design for testability

If code isn't testable, refactor it. Signs:

- You want to reach for a mock
- You can't inject a dependency
- You need to test private internals
- Setup requires too much global state

Aim for deep modules: small interface, deep implementation. Fewer methods = fewer tests needed, simpler params = simpler setup.

## Two test categories, no others

Every test in this repo lives in exactly one of these shapes:

1. **Unit tests with ports and adapters** — production code receives its real-world dependencies (DB, HTTP, CLI process, clock, randomness, filesystem, other modules) through an injected interface. Tests wire a typed in-memory fake colocated with the production module. **No `vi.mock`, `vi.hoisted`, `vi.spyOn` of own exports, JSDOM, `@testing-library` component mounting, RN test renderer, monkey-patched globals, or fake-server fixtures.** If a test needs any of those, the production module is missing a port — fix the seam, then write the test against a fake adapter.
2. **Real end-to-end tests** — real daemon, real network, real browser (Playwright for app code) or a real isolated server instance (for daemon code). No JSDOM, no mocked transport.

Anything in between — component tests in JSDOM, vitest tests that mock the module under test, tests that assert on private state — is slop on its way out.
