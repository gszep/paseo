import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repoRoot = join(import.meta.dirname, "..");

test("packed server carries the private Chi closure outside the checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "paseo-packed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const server = join(source, "packages/server");
  const installed = join(root, "installed");
  const native = join(source, "node_modules/@henkaku-center/chi-native");
  await Promise.all([
    mkdir(join(server, "scripts"), { recursive: true }),
    mkdir(native, { recursive: true }),
    mkdir(installed),
  ]);
  execFileSync("tar", [
    "-xzf",
    join(repoRoot, "vendor/henkaku-center-chi-native-0.0.0.tgz"),
    "-C",
    native,
    "--strip-components=1",
  ]);
  await cp(
    join(repoRoot, "packages/server/scripts/stage-chi-native.mjs"),
    join(server, "scripts/stage-chi-native.mjs"),
  );
  const manifest = JSON.parse(
    await readFile(join(repoRoot, "packages/server/package.json"), "utf8"),
  );
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ private: true, workspaces: ["packages/server"] }),
  );
  await writeFile(
    join(server, "package.json"),
    JSON.stringify({
      name: "packed-server-fixture",
      version: "1.0.0",
      type: "module",
      files: ["entry.mjs"],
      dependencies: {
        "@henkaku-center/chi-native": manifest.dependencies["@henkaku-center/chi-native"],
      },
      bundleDependencies: manifest.bundleDependencies,
    }),
  );
  await writeFile(
    join(server, "entry.mjs"),
    'export { continueNative } from "@henkaku-center/chi-native/continuation";',
  );
  execFileSync(process.execPath, [join(server, "scripts/stage-chi-native.mjs")]);
  const npm = (args, cwd) =>
    execFileSync("npm", args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      shell: process.platform === "win32",
    });
  npm(["pack", "--offline", "--ignore-scripts", "--pack-destination", root], server);
  await rm(source, { recursive: true, force: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ private: true }));
  npm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(root, "packed-server-fixture-1.0.0.tgz"),
    ],
    installed,
  );
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import assert from "node:assert/strict"; const core = await import("./node_modules/packed-server-fixture/entry.mjs"); assert.equal(typeof core.continueNative, "function");',
    ],
    { cwd: installed },
  );
});

function assertNoDirectWorkerLaunch(label, command) {
  for (const workerEntrypoint of [
    "src/server/index.ts",
    "dist/server/server/index.js",
    "src/server/daemon-worker.ts",
    "dist/server/server/daemon-worker.js",
  ]) {
    assert.ok(
      !command.includes(workerEntrypoint),
      `${label} must not launch ${workerEntrypoint} directly: ${command}`,
    );
  }
}

function assertNoSpawnedWorkerEntrypoint(label, source) {
  assertNoDirectWorkerLaunch(label, source);
  assert.doesNotMatch(
    source,
    /spawn\([^)]*["'`][^"'`]*\.\.\/index\.ts["'`]/s,
    `${label} must not spawn ../index.ts directly`,
  );
}

test("every executable daemon entrypoint enters the supervisor", async () => {
  const [
    serverPackageSource,
    appIsolatedHostDaemon,
    serverConnectionOfferE2e,
    desktopRuntimePaths,
    nixPackage,
    nixModule,
  ] = await Promise.all([
    readFile(join(repoRoot, "packages/server/package.json"), "utf8"),
    readFile(join(repoRoot, "packages/app/e2e/support/helpers/isolated-host-daemon.ts"), "utf8"),
    readFile(
      join(repoRoot, "packages/server/src/server/daemon-e2e/connection-offer.e2e.test.ts"),
      "utf8",
    ),
    readFile(join(repoRoot, "packages/desktop/src/daemon/runtime-paths.ts"), "utf8"),
    readFile(join(repoRoot, "nix/package.nix"), "utf8"),
    readFile(join(repoRoot, "nix/module.nix"), "utf8"),
  ]);

  const serverPackage = JSON.parse(serverPackageSource);
  const startScript = serverPackage.scripts?.start ?? "";
  const devScript = serverPackage.scripts?.dev ?? "";
  const devTsxScript = serverPackage.scripts?.["dev:tsx"] ?? "";

  assert.match(startScript, /dist\/scripts\/supervisor-entrypoint\.js/);
  assertNoDirectWorkerLaunch("server start script", startScript);
  assert.match(devScript, /scripts\/dev-runner\.ts/);
  assertNoDirectWorkerLaunch("server dev script", devScript);
  assert.match(devTsxScript, /scripts\/dev-runner\.ts/);
  assertNoDirectWorkerLaunch("server dev:tsx script", devTsxScript);

  assert.match(
    appIsolatedHostDaemon,
    /spawnTsx\("scripts\/supervisor-entrypoint\.ts", \["--dev"\]/,
  );
  assertNoSpawnedWorkerEntrypoint("app e2e isolated host daemon", appIsolatedHostDaemon);

  assert.match(serverConnectionOfferE2e, /scripts\/supervisor-entrypoint\.ts/);
  assertNoSpawnedWorkerEntrypoint("server daemon e2e process launch", serverConnectionOfferE2e);

  assert.match(desktopRuntimePaths, /"dist", "scripts", "supervisor-entrypoint\.js"/);
  assert.match(desktopRuntimePaths, /"scripts", "supervisor-entrypoint\.ts"/);
  assertNoDirectWorkerLaunch("desktop runtime paths", desktopRuntimePaths);

  assert.match(nixPackage, /dist\/scripts\/supervisor-entrypoint\.js/);
  assertNoDirectWorkerLaunch("Nix package wrapper", nixPackage);
  assert.match(nixPackage, /--set PASEO_NODE_ENV production/);
  assert.doesNotMatch(nixPackage, /--set(-default)?\s+NODE_ENV\b/);
  assert.doesNotMatch(nixModule, /\bNODE_ENV\b\s*=/);
  assert.doesNotMatch(nixModule, /\bPASEO_NODE_ENV\b/);
});
