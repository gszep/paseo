# Agent write confinement

**Status: experimental launcher; production agent admission is closed.** This
change does not complete Phase 0 or Phase 1. Do not advertise confined builders
or count these tests as whole-agent acceptance.

## Admission and execution boundary

OpenCode has two execution owners in Paseo. Its service executes native tools,
file edits, shell commands, local plugins and subprocesses. Paseo's bridge/MCP
tools execute inside the daemon and can create terminals, workspace scripts and
other agents. A sandbox around the OpenCode CLI alone leaves the second owner
unconfined. A shell-only hook also misses in-process file edits.

The intended boundary is a **dedicated sandboxed OpenCode service per agent**,
plus a confined broker for every daemon-owned execution path. Child agents must
inherit or narrow that policy. Never reuse a shared unconfined generation for a
confined agent. The runtime needs a host-service network broker: allowing access
to the daemon's loopback/Unix sockets would restore unconfined execution.

The production OpenCode runtime adapter recognizes this per-agent request in
`featureValues` on create, resume and import:

```json
{
  "writeConfinement": {
    "mode": "worktree",
    "scratchRoots": []
  }
}
```

Omission or `mode: "off"` preserves current behavior. `worktree` and `read-only`
currently **refuse admission**, with an actionable error and a structured
`guardrail` log record. Invalid opt-ins also refuse. This is a reservation and
fail-closed integration gate, not an enabled security feature; it is deliberately
absent from the feature picker. Do not configure it on an existing agent expecting
to retrofit a running process. Live feature mutation rejects the unknown feature.

## Experimental process launcher

`packages/server/src/server/agent/confinement/` contains the candidate policy and
process boundary used by the kernel tests. It is not called by production tool
execution. It canonicalizes worktree/scratch roots, hashes the normalized policy,
generates an execution UUID in the parent and records the requested agent,
session, turn and tool coordinates with cwd, worktree, digest, launcher PID and
outcome. Calls sharing a tool ID receive distinct execution IDs. No identity is
taken from child environment variables or output.

The macOS backend uses `/usr/bin/sandbox-exec`, unrestricted filesystem reads,
explicit write roots and default-denied host IPC/network access. It denies
hardlink creation, moving write roots and the read-FD-mutating fcntls 80/110.
The Linux backend uses `/usr/bin/bwrap`, a read-only host, writable root binds,
private PID/user/network/IPC namespaces, no capabilities, disabled nested user
namespaces and an architecture-checked seccomp filter. The filter blocks socket
creation, hardlinks, ptrace, process-memory writes, handle-based opens, BPF and
io_uring setup. Linux's private `/proc` and `/dev` replace host process/device
interfaces. Neither backend grants network access; this cannot yet run the
model-connected OpenCode service.

The launcher supplies fresh standard-stream pipes and no caller file descriptors.
The Linux policy pipe is consumed by bubblewrap before target exec. The launcher
itself receives a minimal environment; caller loader variables are only applied
after sandbox entry. Neither output nor exit status is trusted denial evidence.

## Git metadata and caches

There is no implicit write grant to `$HOME`, `/tmp`, shared package stores or a
repository's `.git`. Pass pre-created, agent-private scratch/cache directories
explicitly and set package-manager cache/temp environment variables accordingly.
Use independent installs: pre-existing multiply linked files in any writable root
are rejected, including links whose other names are also inside that root.
Symlinks are not traversed by the admission scan; the kernel checks referents
when the child accesses them.

Linked worktrees keep their index under the main repository's
`.git/worktrees/<name>` and share objects and refs. Granting that entire `.git`
would let a builder change other worktrees and executable hooks. This prototype
leaves it read-only, so even `git add` fails without further design. Completion
requires a trusted Git broker or an independent private Git database with a
reviewed publication step. Do not put shared Git metadata in `scratchRoots` as
a workaround.

## Evidence contract and remaining acceptance blockers

The launcher reports `started`, `root-exited` and `launch-refused` events.
`coverage: incomplete`, `policyViolation: null` and `outsideWorktree: null` are
intentional. Root exit is not a descendant completion barrier. Admission failures
have `scope: agent-admission` and do not count as attempted forbidden writes.
These records do not implement the Phase 5e failed-attempt ledger.

Before opening production admission:

1. **Trusted native tool attribution:** add OpenCode runtime hooks that bind a
   tool execution to its actual process tree before spawning. Provider timeline
   events and agent-controlled environment values are insufficient, especially
   for concurrent Code Mode children. Record process birth identity and preserve
   ownership through detached descendants and daemon restart.
2. **Daemon execution broker:** cover terminals, workspace scripts, background
   jobs, child agents and filesystem tools. Deny or broker external MCP/services
   that execute outside the sandbox. Validate the real managed provider path.
3. **Shared-inode isolation:** the admission scan is not atomic. An unconfined
   concurrent writer can introduce a hardlink after admission. A path allowlist
   then permits changes to the outside inode. Use an independently backed private
   worktree/scratch filesystem, or another kernel-enforced inode isolation design.
   A pre-existing hardlink is rejected in userspace today, **not refused by the OS
   at mutation time**. The requested hardlink acceptance is therefore incomplete.
4. **Complete denial collection:** the Seatbelt profile tags kernel messages with
   its execution UUID, but no trusted collector ingests them here. An unprivileged
   `log show` probe on the validation host returned no tagged sandbox denials.
   Read-only bubblewrap mounts do not emit an application audit stream. Add a
   privileged/entitled collector or equivalent kernel evidence path, including
   loss reporting and process attribution. Do not parse stderr as proof or treat
   a zero exit code as a clean verdict. Persist confirmed violations into Phase
   5e exactly once; collector loss must invalidate completeness.
5. **Provider usability and lifecycle:** validate the network broker, private
   runtime storage, Git broker, package installs, PTYs, restart/resume and complete
   descendant lifetimes on both operating systems. Real OpenCode acceptance and
   arbitrary orphan completion have not passed.

## Validation

On September 30 UTC / October 1 JST, 2026, the same 22 kernel/admission-boundary
tests passed on macOS (Darwin 24.6.0 x64) and via SSH on Linux
(7.0.0-34-generic x64, bubblewrap 0.9.0), both Node 24.18.0. Five production
admission tests also passed on macOS. Linux used an isolated temporary directory
and its own dependency install. No live daemon was restarted.

The kernel suite covers permitted worktree/scratch writes, outside reads,
symlink ancestors, an in-sandbox symlink swap, new hardlinks, rename both ways,
unlink, chmod/fchmod, timestamps, truncation, detached process groups, writable
FD non-inheritance, concurrent calls, Unix/TCP host-service denial, read-only
policy, quoting, and shared Git/cache refusal. It reproduces the **September 30,
2026 `ln -sfn` loop through a symlinked `node_modules`** against a synthetic second
checkout and verifies its original link remains unchanged. All fixtures use
throwaway targets, never live checkouts.

```sh
cd packages/server
npx vitest run src/server/agent/confinement/execution.test.ts --bail=1
npx vitest run src/server/agent/confinement/admission.test.ts --bail=1
```

The existing Ubuntu server-test CI job installs bubblewrap. Kernel tests skip
Windows, which has no backend; opting in on an unsupported platform never falls
back to unconfined execution.

Launch benchmark: 5 warmups followed by 40 interleaved samples, empty worktree,
`/usr/bin/true`, measured through process close. Includes per-execution policy
scan, excludes module loading and initial preparation. This does not measure
installed dependency-tree scan cost or model/tool latency.

| Host  | Plain p50 | Confined p50 | Added p50 | Confined p95 |
| ----- | --------: | -----------: | --------: | -----------: |
| macOS |  10.41 ms |     28.97 ms |  18.56 ms |     36.16 ms |
| Linux |   3.01 ms |     15.91 ms |  12.90 ms |     17.78 ms |

Reproduce from the repository root:

```sh
node --import tsx scripts/measure-write-confinement.mjs
```

## Prior art

- [Anthropic sandbox-runtime macOS implementation at e87c1096](https://github.com/anthropics/sandbox-runtime/blob/e87c1096eef31482491512eb218428f74a56e2b9/src/sandbox/macos-sandbox-utils.ts): default-deny profile, execution tags, root movement and IPC restrictions. Inspected September 30, 2026; no dependency added.
- [Codex seatbelt.rs at 7219fd735](https://github.com/openai/codex/blob/7219fd735bef2f9cfd0363fecdbbb212e3df5255/codex-rs/sandboxing/src/seatbelt.rs): trusted executable path, writable-root normalization, daemon socket protection, read-FD fcntl restrictions.
- [bubblewrap security model](https://github.com/containers/bubblewrap#sandbox-security): namespace setup is only part of the boundary; inherited capabilities and host services require separate policy.
