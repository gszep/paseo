import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
export function run(args, cwd = root) {
  const result = spawnSync(npm, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`npm ${args.join(" ")} failed (${result.status})`);
}

export function hashFiles(files, cwd = root) {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    hash.update(file).update("\0");
    const path = join(cwd, file);
    hash
      .update(lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path))
      .update("\0");
  }
  return hash.digest("hex");
}

export function tracked(cwd = root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

export function installInputs(files) {
  // Include every script/patch and vendored input: npm lifecycle hooks can read
  // outside package.json. Native snapshots must also match the complete runtime.
  return files.filter(
    (file) =>
      /(^|\/)(package(-lock)?\.json|\.npmrc)$/.test(file) ||
      /^(scripts|patches|vendor)\//.test(file) ||
      /^packages\/[^/]+\/scripts\//.test(file),
  );
}

export function environmentKey(cwd = root, env = process.env) {
  const version = execFileSync(npm, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  }).trim();
  return [
    "env-v1",
    env.ImageOS ?? process.platform,
    env.ImageVersion ?? "local",
    process.arch,
    process.version,
    process.versions.modules,
    version,
    env.ONNXRUNTIME_NODE_INSTALL ?? "default",
    hashFiles(installInputs(tracked(cwd)), cwd),
  ].join("-");
}

export function validInstall(key, cwd = root) {
  try {
    const stamp = JSON.parse(readFileSync(join(cwd, "node_modules/.ci-install-key"), "utf8"));
    if (stamp.key !== key || stamp.layout !== hashFiles(["node_modules/.package-lock.json"], cwd))
      return false;
    // npm's successful frozen install may deduplicate placements from the input
    // lock. Verify its actual installed layout, bound to the exact input key.
    const lock = JSON.parse(readFileSync(join(cwd, "node_modules/.package-lock.json"), "utf8"));
    for (const [path, info] of Object.entries(lock.packages)) {
      if (!path.includes("node_modules/")) continue;
      const installed = join(cwd, path);
      if (info.link) {
        if (realpathSync(installed) !== realpathSync(join(cwd, info.resolved))) return false;
      } else {
        if (!existsSync(installed) && info.optional) continue;
        if (
          JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version !== info.version
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

export function treeFiles(paths, cwd = root) {
  const files = [];
  function visit(path) {
    const entry = lstatSync(join(cwd, path));
    if (entry.isDirectory())
      for (const name of readdirSync(join(cwd, path))) visit(`${path}/${name}`);
    else files.push(path);
  }
  for (const path of paths) visit(path);
  if (!files.length) throw new Error("empty build output");
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const key = environmentKey();
  if (process.argv[2] === "keys") {
    output("key", key);
    output(
      "npm",
      execFileSync(npm, ["config", "get", "cache"], {
        encoding: "utf8",
        shell: process.platform === "win32",
      })
        .trim()
        .replaceAll("\\", "/") + "/_cacache",
    );
    output(
      "browser",
      (process.platform === "win32"
        ? join(process.env.LOCALAPPDATA, "ms-playwright")
        : join(homedir(), ".cache/ms-playwright")
      ).replaceAll("\\", "/"),
    );
  } else if (process.argv[2] === "install") {
    const started = Date.now();
    let hit = validInstall(key);
    if (hit) {
      // patch-package verifies/applies the exact pinned patches on restored trees.
      const patches = spawnSync(process.execPath, ["scripts/postinstall-patches.mjs"], {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          PATH:
            join(root, "node_modules/.bin") +
            (process.platform === "win32" ? ";" : ":") +
            process.env.PATH,
        },
      });
      hit = patches.status === 0;
    }
    if (!hit) {
      const result = spawnSync(process.execPath, ["scripts/npm-retry.mjs", "ci"], {
        cwd: root,
        stdio: "inherit",
      });
      if (result.status !== 0) process.exit(result.status ?? 1);
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(
        join(root, "node_modules/.ci-install-key"),
        JSON.stringify({ key, layout: hashFiles(["node_modules/.package-lock.json"]) }),
      );
    }
    console.log(
      `CI dependencies: ${hit ? "validated snapshot" : "frozen install"}, ${Date.now() - started}ms`,
    );
  } else throw new Error("expected keys or install");
}
