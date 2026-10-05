import path from "node:path";

// A sandboxed agent can write its checkout, including `.git` pointers and any
// repository config a nested `.git` directory carries. Git run there by an
// unsandboxed process would execute that config (fsmonitor, filter drivers,
// hooks). Daemon git commands inside a protected checkout therefore run under
// nono with read-only access and no network.

export interface SandboxedGitWrapper {
  nono: string;
  git: string;
  readPaths: string[];
  readFiles: string[];
}

const guards = new Map<string, Promise<SandboxedGitWrapper>>();

export function protectSandboxedCheckout(
  root: string,
  resolve: () => Promise<SandboxedGitWrapper>,
): void {
  const key = path.resolve(root);
  if (guards.has(key)) return;
  const wrapper = resolve();
  // Rejections surface on each git command that needs the wrapper.
  wrapper.catch(() => undefined);
  guards.set(key, wrapper);
}

export function sandboxedGitWrapperFor(cwd: string): Promise<SandboxedGitWrapper> | null {
  const resolved = path.resolve(cwd);
  for (const [root, wrapper] of guards) {
    const relative = path.relative(root, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return wrapper;
    }
  }
  return null;
}

export function sandboxedGitInvocation(
  wrapper: SandboxedGitWrapper,
  cwd: string,
  gitArgs: string[],
): { command: string; args: string[] } {
  const reads = [cwd, ...wrapper.readPaths].flatMap((dir) => ["--read", dir]);
  const files = wrapper.readFiles.flatMap((file) => ["--read-file", file]);
  return {
    command: wrapper.nono,
    args: [
      "run",
      "--silent",
      "--no-rollback",
      "--no-audit",
      "--no-diagnostics",
      "--block-net",
      ...reads,
      ...files,
      "--",
      wrapper.git,
      ...gitArgs,
    ],
  };
}

export function resetSandboxedCheckoutsForTests(): void {
  guards.clear();
}
