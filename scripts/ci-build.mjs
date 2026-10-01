import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { environmentKey, hashFiles, root, run, tracked, treeFiles } from "./ci-cache.mjs";

const shared = ["highlight", "relay", "protocol", "client", "plugin"];
export const targets = {
  "build:server-deps": shared,
  "build:server": [...shared, "server", "cli"],
  "build:app-deps": ["highlight", "protocol", "client", "plugin", "expo-two-way-audio"],
  "build:relay": ["relay"],
  "build:client": ["protocol", "client"],
  "build:plugin": ["protocol", "client", "plugin"],
  "build:audio": ["expo-two-way-audio"],
};

export function inputs(target, files) {
  if (!targets[target]) throw new Error(`unknown build target: ${target}`);
  // Client imports relay even where the owning command does not build relay.
  const packages = [...targets[target], ...(targets[target].includes("client") ? ["relay"] : [])];
  // Union of complete source trees, generators, assets, root configuration and
  // runtime skills. Generated validators are an output, never a source key.
  return files.filter(
    (file) =>
      !file.startsWith("packages/protocol/src/generated/") &&
      (!file.includes("/") ||
        /^(scripts|patches|vendor|skills)\//.test(file) ||
        packages.some((name) => file.startsWith(`packages/${name}/`))),
  );
}

export function outputs(target) {
  const packages = target === "build:plugin" ? ["plugin"] : targets[target];
  return packages
    .map((name) => `packages/${name}/${name === "expo-two-way-audio" ? "build" : "dist"}`)
    .concat(
      packages.includes("protocol")
        ? ["packages/protocol/src/generated/validation/ws-outbound.aot.ts"]
        : [],
    );
}

export function keyFor(target, files, envKey, cwd = root) {
  return createHash("sha256")
    .update(envKey)
    .update(target)
    .update(hashFiles(inputs(target, files), cwd))
    .digest("hex");
}

export function validBuild(stamp, key, paths, cwd = root) {
  try {
    return stamp.key === key && stamp.output === hashFiles(treeFiles(paths, cwd), cwd);
  } catch {
    return false;
  }
}

export function build(target) {
  const paths = outputs(target);
  // Local calls keep their normal fresh-build semantics. CI archives are only
  // candidates: each task checks its exact transitive inputs AND output bytes.
  const key = keyFor(target, tracked(), environmentKey());
  const stampPath = join(root, ".ci-build", `${target.replaceAll(":", "-")}.json`);
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    /* cold */
  }
  if (process.env.CI && stamp && validBuild(stamp, key, paths)) {
    console.log(`CI build ${target}: exact verified hit`);
    return;
  }
  const started = Date.now();
  // A renamed/deleted source must not leave stale emitted JS in a restored dist.
  for (const path of paths) rmSync(join(root, path), { recursive: true, force: true });
  run(
    target === "build:audio"
      ? ["run", "build", "--workspace=@getpaseo/expo-two-way-audio"]
      : ["run", target],
  );
  mkdirSync(join(root, ".ci-build"), { recursive: true });
  writeFileSync(stampPath, JSON.stringify({ key, output: hashFiles(treeFiles(paths)) }));
  console.log(`CI build ${target}: built, ${Date.now() - started}ms`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  build(process.argv[2]);
