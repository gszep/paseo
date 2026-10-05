# Subagent isolation

An agent that creates another agent gets a new git worktree for it by default, so parallel
subagents never edit the same working tree, and runs it inside a
[nono](https://github.com/nolabs-ai/nono) sandbox. Agents created by people (the app, a human shell,
top-level MCP) keep the placement they ask for and run unconfined, like OpenCode itself. This is the
operator decision of October 4, 2026; existing agents keep the behavior they were created with.

## Who gets a worktree

The policy applies to every creation with an agent caller:

- agent-scoped MCP `create_agent`, including the legacy `relationship`/`workspace` shape and
  detached creation;
- `paseo run` with `PASEO_AGENT_ID` set, which sends `callerAgentId` on `create_agent_request`;
- client SDK and plugin creates that pass a `parent`.

Admission lives in the daemon (`packages/server/src/server/agent/create-agent/isolation.ts`), so
no client flag skips it. `createAgentCommand` refuses an MCP create with a caller but no isolation
decision.

The selected workspace is only the **source**: `workspaceId`, `--workspace`, and the legacy
`current`/`existing`/`directory` placements choose which checkout the worktree branches from. They
never grant a shared checkout. The worktree branches from the source checkout's current branch, or
its commit when HEAD is detached, through the normal worktree workspace path (`createPaseoWorktree`,
first-agent branch auto-naming, repository setup). Uncommitted changes are not copied; commit what
the subagent needs first.

| Source                                                                     | Result                                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Inside a git work tree                                                     | New worktree workspace; label `created`                                                |
| Explicit new worktree (`--new-workspace worktree`, legacy worktree target) | That worktree; label `created`                                                         |
| Not inside a git repository                                                | Runs in the source directory; label `not-git`; note in the MCP response and CLI output |
| Repository without a commit, or git cannot inspect it                      | Creation fails and names the opt-out                                                   |

If creating the worktree or the agent fails, the MCP path removes the new worktree before
returning the error; the `create_agent_request` path already did.

## Opting out

Pass `isolation: { worktree: false, reason }` to MCP `create_agent`, or `--share-checkout <reason>`
to `paseo run`, to share the source checkout and workspace. Pass
`isolation: { worktree: true, sandbox: false, reason }`, or `--unsandboxed <reason>`, to run without
the sandbox. One reason covers both opt-outs and is required: one line, at most 200 characters. A
worktree opt-out cannot be combined with an explicit new worktree. Under `PASEO_AGENT_ID`,
`paseo run --new-workspace local` also requires `--share-checkout`, because a local workspace shares
the checkout.

A sandboxed agent cannot create an unsandboxed one. Its checkout is untrusted outside the sandbox
(creating a worktree from it would run git and its hooks unconfined), so its subagents must pass
`worktree: false` and share its sandboxed worktree.

## Record

The decision is stored as `isolation` on the agent record (`worktree`, `sandbox`: `nono` or
`opted-out`, `reason`, `decidedBy`). That record is the authority: resume, reload and daemon restart
read it, never the caller or the labels. The daemon also stamps `paseo.isolation.worktree` (`created`,
`opted-out`, or `not-git`), `paseo.isolation.sandbox` and, for an opt-out, `paseo.isolation.reason`.
Caller-supplied `paseo.isolation.*` labels are dropped. Each decision is logged as a
`subagent_isolation` event in `$PASEO_HOME/daemon.log` with the caller, agent, workspace, source, base
ref, sandbox and reason. Labels stay editable through `update_agent`; they drive cascade and cleanup
only.

## Archive and cleanup

Archiving a subagent never removes its worktree. A subagent labelled `created` is not a separate
home: when its parent is archived it archives with the parent instead of being detached, unless a
client still has it open in a tab ([agent lifecycle](agent-lifecycle.md#relationships)). Its
workspace stays active, and the daemon logs `Archived subagent keeps its worktree workspace for
cleanup`.

An archived agent labelled `paseo.isolation.worktree=created` marks its workspace for cleanup. To
clean up:

1. List candidates: `paseo ls -a -g --label paseo.isolation.worktree=created` and keep the archived
   rows. Their cwd is the worktree.
2. Commit or push anything worth keeping. Archiving the workspace force-removes the worktree
   directory, including uncommitted changes; the branch and its commits stay in the repository.
3. Archive the workspace whose directory is that cwd: `paseo workspace ls`, then
   `paseo workspace archive <workspace-id>`, or MCP `archive_workspace`. The directory is removed
   only when no other active workspace references it.

Unarchiving the agent before step 3 resumes it in the same worktree.

## Sandbox

Admission checks the sandbox before any worktree exists. Only the OpenCode V2 provider can run
sandboxed; a missing or wrong nono, or another provider, refuses creation unless the caller opts out.

A sandboxed agent always gets a dedicated OpenCode server launched as
`nono run --profile <generated> -- opencode serve` (`agent/providers/opencode/v2/runtime.ts`,
`agent/sandbox/nono.ts`). Everything the agent executes descends from that server — its shell and bash
tool, OpenCode plugins, MCP servers it starts — and inherits the confinement. A resumed session never
reuses a server with different confinement. The generated profile
(`$PASEO_HOME/runtime/sandbox/<agent>/profile.json`, 0600):

- Read-write: the worktree and private `config`/`data`/`cache`/`state`/`tmp` beside the profile. The
  child's `HOME` and XDG variables point there; nono keeps its own state under the daemon user's real
  HOME, which is never granted.
- Git: the shared repository is read-only, because its config and hooks run in the orchestrator's
  unconfined git. Writable: this worktree's gitdir, `objects`, and
  `refs/heads/paseo-subagents/<slug>/` with its reflog directory. Sandboxed subagents therefore get the
  branch `paseo-subagents/<slug>/work`; first-agent auto-renaming cannot move it, because daemon git in
  a sandboxed checkout is read-only.
- Read-only: the OpenCode executable directory and Paseo's materialized bridge plugin. On macOS a
  literal (non-recursive) Seatbelt rule lets OpenCode realpath the main checkout; its file names are
  listable, file contents are not.
- Denied: the daemon user's macOS temp and cache root (`/var/folders/<x>/<y>`), which nono's default
  system group would otherwise expose read-only.
- Linux: `af_unix_mediation: pathname` with no socket grants. Without it the user service manager is
  reachable (`systemd-run --user` executed outside the sandbox in testing). A granted socket would be
  exposed to nono's documented check-then-connect race, so none is granted.
- Network: proxy-only, allowlisted model, catalogue and npm hosts plus credential routes. Loopback is
  reachable only through nono's proxy, so the daemon, its MCP endpoint and other agents' servers are out
  of reach.
- Environment: only `PATH`, locale, terminal, user and the agent's own variables cross into nono;
  daemon secrets, `SSH_AUTH_SOCK` and session-bus addresses do not. `OPENCODE_DISABLE_PROJECT_CONFIG=1`
  is required, so project `opencode.json` files do not load in sandboxed agents.

### Paseo tools and terminals

The bridge plugin inside the sandbox reaches the daemon through a nono reverse route. The daemon
issues a per-agent bridge credential that nono injects; the child sees only nono's phantom token, and
the bridge serves only that agent's sessions.

Daemon-side tools would execute outside the sandbox, so a sandboxed agent's catalog is an allowlist
(`SANDBOXED_AGENT_PASEO_TOOLS`): `create_agent`, provider and model listing, `human_prompts`, `speak`.
Terminals, workspace scripts, schedules, workspace management and tools that prompt or change other
agents are absent, including through the MCP route. The agent's terminal is its own shell inside the
sandbox.

### Git and GitHub

Pushes go through nono's credential proxy. When the daemon environment has `GITHUB_TOKEN` (nono's own
convention), the profile adds a `github_git` route; the bridge plugin writes the sandbox's private
global git config to rewrite `https://github.com/` to that route and to send the phantom token as
Basic credentials (nono's 401 carries no challenge, so git must send them first). The real token never
enters the sandbox. Without `GITHUB_TOKEN`, sandboxed agents cannot push to GitHub. `gh` is not
supported inside the sandbox.

Daemon git commands whose working directory is inside a sandboxed agent's checkout run under nono
read-only with no network (`utils/sandboxed-git.ts`): the agent controls that checkout's `.git`
pointer and any nested repository config, which an unconfined `git diff` or `git status` would
execute. A checkout is protected when its sandboxed server starts and, for persisted sandboxed agents,
at daemon start before any polling. Orchestrator agents are not protected this way: integrate a
sandboxed subagent's work by fetching its branch, not by running git inside its worktree.

## Operating the sandbox

Install nono 0.79.0 on each daemon host (the Chi installer pins it,
[henkaku-center/chi#81](https://github.com/henkaku-center/chi/pull/81)); check `nono --version`.
Paseo refuses any other version. Release archives, matching the release's `SHA256SUMS.txt`:

| Target            | Archive                                         | SHA-256                                                            |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| macOS arm64       | `nono-v0.79.0-aarch64-apple-darwin.tar.gz`      | `e46365b08aecff0acc9c7b86f5d4b1745c385034189d50822156e43881479168` |
| macOS x64         | `nono-v0.79.0-x86_64-apple-darwin.tar.gz`       | `276f7f6af212596554a9247a48903256d919cf43c97771def1300ac336002912` |
| Linux arm64/glibc | `nono-v0.79.0-aarch64-unknown-linux-gnu.tar.gz` | `c4a4f4b9ae318574d30d352127a34dcc919c4d6682ee8fbd30bb8d2bd2e0e85d` |
| Linux x64/glibc   | `nono-v0.79.0-x86_64-unknown-linux-gnu.tar.gz`  | `36dfeeb6e8c6a30c43f80ba239e2460af43047c008153af527fdd893c1f02392` |

Inspect a sandboxed agent's profile under `$PASEO_HOME/runtime/sandbox/<agent>/` and its server's
OpenCode log in that directory's `data/opencode/log/`.

Run the real acceptance test on each platform with nono on `PATH`:

```bash
cd packages/server
npx vitest run src/server/agent/providers/opencode/v2/sandbox.local.e2e.test.ts
```

It drives Paseo's runtime against real nono and OpenCode with throwaway directories and synthetic
credentials: worktree commits succeed; writes to the source checkout, its hooks and `main` are refused;
host gh, SSH, keychain and git config files are unreadable; the daemon and other agents' sessions are
unreachable; on Linux the user service manager is unreachable; an authenticated push through nono's
proxy succeeds while the child never sees the credential; a planted `diff.external` cannot escape the
daemon's git; the orchestrator's server stays unconfined.

## Known gaps

- **Model credentials.** A sandboxed server has private OpenCode data, so credentials kept in the
  user's OpenCode data directory, plugin stores or the keychain are unavailable to it. On the current
  hosts a sandboxed subagent therefore has no model provider. Granting those stores would expose raw
  model tokens to the agent; enabling the default in practice needs an operator decision (proxy-injected
  provider keys, or an accepted exposure).
- The object store is writable, so an agent could replace loose objects that other checkouts read
  later. A hardlink from an unconfined process into a writable grant is an accepted upstream gap,
  already reported privately to nono.
- Network destinations are a static allowlist.
- Schedules and heartbeats create agents from the daemon, which are top-level and unconfined.
- An explicit worktree target for a sandboxed subagent keeps its requested branch name; unless that
  branch sits in its own directory, commits there cannot update the branch ref.
- nono's published OpenCode profile grants keychain and shared agent directories, so Paseo generates
  its own; a narrower upstream profile is requested in
  [nolabs-ai/nono#2052](https://github.com/nolabs-ai/nono/issues/2052).

Do not describe a worktree alone as a security boundary: an agent created with `sandbox: false` can
read and write anything its user can, including the source checkout and sibling worktrees.
