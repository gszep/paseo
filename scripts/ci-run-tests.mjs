import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selection, fullSelection } from "./ci-selection.mjs";
import { critical, criticalServerIntegration } from "./ci-test-policy.mjs";

function validFiles(files) {
  return Array.isArray(files) && files.every((file) => /^[\w./-]+$/.test(file));
}

export function commands(pkg, selected, platform = process.platform) {
  if (!/^(server|app|client|protocol|plugin|highlight|relay|cli|website)$/.test(pkg))
    throw new Error(`unknown suite: ${pkg}`);
  const workspace = `--workspace=@getpaseo/${pkg}`;
  const all = selected.full;
  const files = selected.tests[pkg];
  if (!all && !validFiles(files)) throw new Error("invalid selection");
  // cmd.exe has a much smaller argv limit than POSIX. Never truncate the set.
  if (!all && platform === "win32" && files.join(" ").length > 6000)
    return commands(pkg, fullSelection("Windows argv limit"), platform);
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

export function runCommands(tasks, run = runNpm) {
  const errors = [];
  for (const args of tasks) {
    try {
      run(args);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "CI test commands failed");
}

function criticalFiles(pkg) {
  return [...(critical[pkg] ?? []), ...(pkg === "server" ? criticalServerIntegration : [])];
}

export function verifyCriticalCollection(pkg, listed, root = process.cwd()) {
  const found = new Set(listed.map(({ file }) => resolve(file)));
  for (const file of criticalFiles(pkg)) {
    if (!found.has(resolve(root, `packages/${pkg}/${file}`)))
      throw new Error(`Critical test excluded by runner configuration: ${pkg}/${file}`);
  }
}

export function criticalCollectionArgs(pkg) {
  // Vitest's --json takes an OPTIONAL output filename. It MUST come last or
  // the first test path is treated as a destination and overwritten.
  return [
    "exec",
    `--workspace=@getpaseo/${pkg}`,
    "--",
    "vitest",
    "list",
    "--filesOnly",
    ...criticalFiles(pkg),
    "--json",
  ];
}

function checkCriticalCollection(pkg) {
  const files = criticalFiles(pkg);
  if (!files.length) return;
  const args = criticalCollectionArgs(pkg);
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Cannot collect critical tests: ${result.error?.message ?? result.stderr}`);
  verifyCriticalCollection(pkg, JSON.parse(result.stdout));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = process.argv[2];
  const selected = await selection();
  console.log(
    `Selection: ${selected.reason}; ${pkg}: ${selected.full ? "full" : JSON.stringify(selected.tests[pkg])}`,
  );
  const tasks = commands(pkg, selected);
  if (!tasks.length) console.log(`No selected ${pkg} tests; required job remains successful.`);
  // A path can exist while a project's include/exclude configuration omits it.
  checkCriticalCollection(pkg);
  runCommands(tasks);
}
