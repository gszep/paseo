import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selection } from "./ci-selection.mjs";
import { criticalServerIntegration } from "./ci-test-policy.mjs";

export function commands(pkg, selected) {
  if (!/^(server|app|client|protocol|plugin|highlight|relay|cli|website)$/.test(pkg))
    throw new Error(`unknown suite: ${pkg}`);
  const workspace = `--workspace=@getpaseo/${pkg}`;
  const all = selected.full;
  const files = selected.tests[pkg];
  if (!all && (!Array.isArray(files) || files.some((file) => !/^[\w./-]+$/.test(file))))
    throw new Error("invalid selection");
  const result = [];
  if (pkg === "website")
    return all || files.length
      ? [["exec", workspace, "--", "vitest", "run", ...(all ? ["src"] : files)]]
      : [];
  if (all || files.length) {
    const script = pkg === "server" || pkg === "cli" ? "test:unit" : "test";
    result.push(["run", script, workspace, ...(!all ? ["--", ...files] : [])]);
  }
  if (pkg === "server") {
    if (all || selected.packages.includes("server"))
      result.push(["run", "test:integration", workspace]);
    // Run whole files, without intersecting --changed, -t, or the integration allowlist.
    result.push([
      "exec",
      workspace,
      "--",
      "vitest",
      "run",
      "--maxWorkers=1",
      ...criticalServerIntegration,
    ]);
  }
  return result;
}

export function runNpm(args, root = process.cwd()) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm ${args.join(" ")} failed (${result.status ?? result.signal})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = process.argv[2];
  const selected = await selection();
  console.log(
    `Selection: ${selected.reason}; ${pkg}: ${selected.full ? "full" : JSON.stringify(selected.tests[pkg])}`,
  );
  const tasks = commands(pkg, selected);
  if (!tasks.length) console.log(`No selected ${pkg} tests; required job remains successful.`);
  for (const args of tasks) runNpm(args);
}
