# Subagent isolation

An agent that creates another agent gets a new git worktree for it by default, so parallel
subagents never edit the same working tree. Agents created by people (the app, a human shell,
top-level MCP) keep the placement they ask for.

This covers the worktree half of the operator decision of October 4, 2026. Sandboxing subagents
with nono is deferred; see [Deferred: sandbox](#deferred-sandbox).

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
to `paseo run`. The reason is required: one line, at most 200 characters. The subagent then runs in
the source checkout and workspace. An opt-out cannot be combined with an explicit new worktree.
Under `PASEO_AGENT_ID`, `paseo run --new-workspace local` also requires `--share-checkout`, because a
local workspace shares the checkout.

## Record

The daemon stamps `paseo.isolation.worktree` (`created`, `opted-out`, or `not-git`) and, for an
opt-out, `paseo.isolation.reason`. Caller-supplied `paseo.isolation.*` labels are dropped. Each
decision is also logged as a `subagent_isolation` event in `$PASEO_HOME/daemon.log` with the caller,
agent, workspace, source, base ref and reason. Labels stay editable through `update_agent`; the log is
the audit trail, and the labels drive cascade and cleanup only.

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

## Deferred: sandbox

Running each subagent in its own nono-confined OpenCode server is deferred and tracked in
[henkaku-center/chi#84](https://github.com/henkaku-center/chi/issues/84), which lists the blockers.
The design and probe evidence are in [gszep/paseo#17](https://github.com/gszep/paseo/pull/17). Do not describe a
worktree as a security boundary: an unconfined subagent can still read and write anything its user
can, including the source checkout and sibling worktrees.
