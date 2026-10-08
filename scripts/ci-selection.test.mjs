import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import test from "node:test";
import {
  buildGraph,
  selectChanges,
  selection,
  fullSelection,
  criticalSelection,
  changedFiles,
  unitFiles,
} from "./ci-selection.mjs";
import {
  critical,
  criticalCli,
  criticalDirectories,
  criticalExemptions,
  criticalServerIntegration,
} from "./ci-test-policy.mjs";
import {
  commands,
  runCommands,
  verifyCriticalCollection,
  criticalCollectionArgs,
} from "./ci-run-tests.mjs";
import { cliFiles, partition } from "./ci-partition.mjs";

const root = new URL("../", import.meta.url).pathname;
const graph = await buildGraph(root);
const modified = (...files) => files.map((file) => ({ status: "M", file }));
const selected = (file) => selectChanges(graph, modified(file));
const allJobs = Object.keys(fullSelection("test").jobs).sort();
const enabled = (result) =>
  Object.keys(result.jobs)
    .filter((job) => result.jobs[job])
    .sort();
const baseJobs = ["app", "cli", "format", "quality", "sdk", "server"];

function assertCritical(result) {
  if (result.full) return;
  for (const [pkg, files] of Object.entries(critical)) {
    for (const file of files)
      assert.ok(result.tests[pkg].includes(file), `critical lost: ${pkg}/${file}`);
  }
}

test("representative real-tree matrix: jobs, related tests, critical union and broad fallbacks", () => {
  const rows = [
    [
      "leaf highlight",
      "packages/highlight/src/index.ts",
      false,
      allJobs.filter((job) => job !== "relay"),
    ],
    [
      "server core",
      "packages/server/src/server/auth.ts",
      false,
      allJobs.filter((job) => job !== "relay"),
    ],
    [
      "protocol",
      "packages/protocol/src/messages.ts",
      false,
      allJobs.filter((job) => job !== "relay"),
    ],
    [
      "app UI",
      "packages/app/src/chi/reply-model.ts",
      false,
      allJobs.filter((job) => job !== "relay"),
    ],
    ["test helper", "packages/server/src/test-utils/vitest-setup.ts", true, allJobs],
    ["lockfile", "package-lock.json", true, allJobs],
    ["workflow", ".github/workflows/ci.yml", true, allJobs],
    [
      "vendored chi-native",
      graph.files.find((file) => file.endsWith(".tgz") && file.includes("chi-native")),
      true,
      allJobs,
    ],
    ["isolated test", "packages/app/src/chi/reply-model.test.ts", false, baseJobs],
  ];
  for (const [label, file, full, jobs] of rows) {
    assert.ok(file, label);
    const result = selected(file);
    assert.equal(result.full, full, `${label}: ${result.reason}`);
    assert.deepEqual(enabled(result), jobs, label);
    assertCritical(result);
    if (!full && file.includes("reply-model"))
      assert.ok(result.tests.app.includes("src/chi/reply-model.test.ts"));
    if (!full && label === "server core") {
      assert.ok(result.tests.server.includes("src/server/auth.test.ts"));
      for (const browserFile of unitFiles(graph.files, "app").filter((candidate) =>
        candidate.includes(".browser."),
      ))
        assert.ok(result.tests.app.includes(browserFile));
    }
  }
});

test("new/deleted/renamed/typechanged paths, fixtures, assets, configuration and scripts fail open", () => {
  for (const status of ["A", "D", "R100", "T", "?"])
    assert.equal(
      selectChanges(graph, [{ status, file: "packages/app/src/chi/reply-model.ts" }]).full,
      true,
    );
  for (const file of [
    "packages/app/src/new.ts",
    "packages/app/vitest.setup.ts",
    "packages/app/metro.config.js",
    "packages/app/e2e/support/fixtures.ts",
    "packages/cli/tests/helpers/network.ts",
    "scripts/ci-selection.mjs",
    "skills/README.md",
    "package.json",
  ])
    assert.equal(selected(file).full, true, file);
  assert.equal(selectChanges(graph, []).full, true);
});

test("a desktop test-only change cannot lose the job to the process-harness override", () => {
  const file = "packages/desktop/src/features/browser-capture.test.ts";
  const result = selected(file);
  assert.equal(result.full, false);
  assert.equal(result.jobs.desktop, true);
  assert.ok(result.tests.desktop.includes("src/features/browser-capture.test.ts"));
});

test("CLI source lifecycle E2E remains in test:unit inventory and related execution", () => {
  // Only SERVER test:unit excludes .e2e.test.ts. CLI test:unit runs all of src.
  const path = "src/commands/daemon/lifecycle.e2e.test.ts";
  assert.ok(unitFiles(graph.files, "cli").includes(path));
  assert.ok(!unitFiles(graph.files, "server").includes(criticalServerIntegration[0]));
  const result = selected(`packages/cli/${path}`);
  assert.equal(result.full, false);
  assert.ok(commands("cli", result).flat().includes(path));
});

test("selector unit inventories equal the real suite collections; configuration drift cannot hide tests", () => {
  assert.equal(
    graph.packages.get("server").scripts["posttest:unit"],
    "node scripts/chi-security-mutations.mjs",
  );
  // These flags mirror the existing npm suite boundaries, NOT production paths.
  // Compare against the actual runner so changing a package's include/exclude
  // cannot leave a test silently outside the graph's selectable inventory.
  const boundaries = {
    server: ["--exclude", "**/*.e2e.test.ts"],
    app: [],
    client: [],
    protocol: [],
    plugin: [],
    highlight: [],
    relay: [],
    cli: ["src"],
    desktop: ["--exclude", "e2e/**"],
    website: ["--config", "../../vitest.config.ts", "src"],
  };
  for (const [pkg, flags] of Object.entries(boundaries)) {
    if (pkg !== "website") {
      const expected =
        {
          server: 'vitest run --fileParallelism --exclude "**/*.e2e.test.ts"',
          cli: "vitest run src",
          desktop: 'install-electron && vitest run --exclude "e2e/**"',
        }[pkg] ?? "vitest run";
      const script = pkg === "server" || pkg === "cli" ? "test:unit" : "test";
      assert.equal(
        graph.packages.get(pkg).scripts[script],
        expected,
        `${pkg}: npm suite boundary changed; update and prove collection`,
      );
    }
    const listed = JSON.parse(
      execFileSync(
        "npm",
        [
          "exec",
          `--workspace=@getpaseo/${pkg}`,
          "--",
          "vitest",
          "list",
          "--filesOnly",
          ...flags,
          "--json",
        ],
        { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      ),
    );
    const actual = [
      ...new Set(
        listed.map(({ file }) => relative(join(root, "packages", pkg), file).replaceAll("\\", "/")),
      ),
    ].sort();
    assert.deepEqual(unitFiles(graph.files, pkg), actual, pkg);
  }
});

test("stale critical unit or integration inventories run everything", () => {
  for (const missing of [
    `packages/server/${critical.server[0]}`,
    `packages/server/${criticalServerIntegration[0]}`,
    `packages/cli/tests/${criticalCli[0]}`,
  ]) {
    const result = selectChanges(
      { ...graph, files: graph.files.filter((file) => file !== missing) },
      modified("packages/app/src/chi/reply-model.ts"),
    );
    assert.equal(result.full, true, missing);
    assert.match(result.reason, /stale critical/);
  }
});

test("documentation skips unrelated jobs but cannot suppress the critical set", () => {
  const result = criticalSelection(root);
  assert.equal(result.full, false);
  assertCritical(result);
  assert.deepEqual(enabled(result), ["app", "cli", "sdk", "server"]);
});

test("critical inventory cannot lose the named security contracts", () => {
  const required = {
    server: [
      "src/server/auth.test.ts",
      "src/server/bootstrap-auth.test.ts",
      "src/server/config-auth.test.ts",
      "src/server/agent/permission-response.test.ts",
      "src/server/agent/agent-manager.test.ts",
      "src/server/chi/connection.test.ts",
      "src/server/chi/destinations.test.ts",
      "src/server/chi/mentions.test.ts",
      "src/server/chi/provenance.test.ts",
      "src/server/message-receipts/index.test.ts",
    ],
    app: [
      "src/utils/scanned-pairing-offer.test.ts",
      "src/chi/continuation-state.test.ts",
      "src/chi/entry-navigation.test.ts",
      "src/chi/mention-submission.test.ts",
      "src/chi/mention-context.test.ts",
      "src/chi/mention-errors.test.ts",
      "src/chi/reply-model.test.ts",
      "src/chi/inbox-model.test.ts",
      "src/chi/inbox-query.test.ts",
      "src/chi/mentions-unavailable.browser.test.tsx",
      "src/chi/repository-filter.browser.test.tsx",
      "src/chi/sync-notice.browser.test.tsx",
      "src/chi/use-sync-destination.browser.test.tsx",
      "src/composer/actions.test.ts",
      "src/runtime/host-runtime.test.ts",
    ],
    client: ["src/daemon-client.test.ts"],
  };
  for (const [pkg, files] of Object.entries(required))
    for (const file of files) assert.ok(critical[pkg].includes(file), `${pkg}/${file}`);
  assert.ok(
    criticalServerIntegration.includes("src/server/daemon-e2e/agent-rpc-durability.e2e.test.ts"),
  );
  for (const file of [
    "12-permit-ls.test.ts",
    "13-permit-allow-deny.test.ts",
    "32-daemon-set-password.test.ts",
    "34-daemon-status-auth.test.ts",
  ])
    assert.ok(criticalCli.includes(file));
});

test("every test in an always-run critical directory is in the critical inventory", () => {
  // `critical` is a hand-maintained always-run floor. Without this guard a new
  // sibling test in a wholly critical directory (chi/auth capture areas) can
  // land outside the floor and be skippable by a docs-only or unrelated diff.
  for (const [pkg, directories] of Object.entries(criticalDirectories)) {
    assert.ok(critical[pkg], `${pkg}: critical directory has no inventory`);
    for (const directory of directories) {
      const files = unitFiles(graph.files, pkg).filter((file) => file.startsWith(`${directory}/`));
      assert.ok(files.length, `${pkg}/${directory}: no tests found; stale directory guard`);
      for (const file of files) {
        const path = `packages/${pkg}/${file}`;
        if (Object.prototype.hasOwnProperty.call(criticalExemptions, path)) {
          assert.ok(
            typeof criticalExemptions[path] === "string" &&
              criticalExemptions[path].trim().length > 0,
            `${path}: exemption needs a reason`,
          );
        } else {
          assert.ok(
            critical[pkg].includes(file),
            `critical directory test outside the floor: ${path}`,
          );
        }
      }
    }
  }
  // An exemption must still point at a guarded, tracked file. A stale or
  // misspelled allowlist entry silently reopens the gap it was meant to scope.
  for (const path of Object.keys(criticalExemptions)) {
    const guarded = Object.entries(criticalDirectories).some(([pkg, directories]) =>
      directories.some((directory) => path.startsWith(`packages/${pkg}/${directory}/`)),
    );
    assert.ok(guarded, `stale critical exemption: ${path}`);
    assert.ok(graph.files.includes(path), `critical exemption not tracked: ${path}`);
  }
});

test("critical paths excluded by runner config cannot turn a job green", () => {
  const listed = [...critical.server, ...criticalServerIntegration].map((file) => ({
    file: join(root, "packages/server", file),
  }));
  verifyCriticalCollection("server", listed, root);
  assert.throws(
    () => verifyCriticalCollection("server", listed.slice(1), root),
    /Critical test excluded/,
  );
  assert.throws(
    () => verifyCriticalCollection("server", listed.slice(0, -1), root),
    /Critical test excluded/,
  );
});

test("real Vitest critical collection is complete and read-only (optional --json argument last)", () => {
  for (const pkg of Object.keys(critical)) {
    const args = criticalCollectionArgs(pkg);
    // Assert BEFORE launching: reverting this order could overwrite a source file.
    assert.equal(args.at(-1), "--json");
    assert.ok(args.includes("--filesOnly"));
    const paths = [...critical[pkg], ...(pkg === "server" ? criticalServerIntegration : [])].map(
      (file) => join(root, "packages", pkg, file),
    );
    const before = paths.map((file) => readFileSync(file, "utf8"));
    const listed = JSON.parse(
      execFileSync("npm", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }),
    );
    verifyCriticalCollection(pkg, listed, root);
    assert.deepEqual(
      paths.map((file) => readFileSync(file, "utf8")),
      before,
    );
  }
});

test("failed unit commands cannot bypass later critical integration commands or mask failure", () => {
  const tasks = [["unit"], ["integration"], ["critical"]];
  const ran = [];
  assert.throws(
    () =>
      runCommands(tasks, (args) => {
        ran.push(args);
        if (args[0] === "unit") throw new Error("failure");
      }),
    AggregateError,
  );
  assert.deepEqual(ran, tasks);
  assert.doesNotThrow(() => runCommands([], () => assert.fail("empty shard launched a test")));
});

test("large Windows related sets fall back to the full command rather than truncated argv", () => {
  const result = {
    full: false,
    packages: [],
    tests: { server: Array.from({ length: 500 }, (_, index) => `src/test-${index}.test.ts`) },
  };
  assert.deepEqual(
    commands("server", result, "win32"),
    commands("server", fullSelection("full"), "win32"),
  );
  assert.ok(commands("server", result, "linux")[0].includes("src/test-499.test.ts"));
});

test("every workspace has a CI suite owner, including website units and audio's consuming app", () => {
  assert.deepEqual([...graph.packages.keys()].sort(), [
    "app",
    "cli",
    "client",
    "desktop",
    "expo-two-way-audio",
    "highlight",
    "plugin",
    "protocol",
    "relay",
    "server",
    "website",
  ]);
  assert.deepEqual(commands("website", fullSelection("main")), [
    [
      "exec",
      "--workspace=@getpaseo/website",
      "--",
      "vitest",
      "run",
      "--config",
      "../../vitest.config.ts",
      "src",
    ],
  ]);
});

test("shadow replay of recorded PR diffs retains the full matrix for broad changes", () => {
  // Actual merged PRs #1, #2, #5 and #6, not hand-invented path samples.
  const merges = [
    "5ef95692072353157293002bc44db8c77ce51569",
    "f49983d3bbbf33a41a971e2dc7f2e52447f238fe",
    "ff8756c2cad5f5708be6d1cc292208c78f8cd425",
    "e444d8d3842f086fac593d6d2956d069f45486e1",
  ];
  for (const merge of merges) {
    const rows = execFileSync(
      "git",
      ["diff", "--name-status", "--no-renames", "-z", `${merge}^1`, merge],
      { cwd: root, encoding: "utf8" },
    ).split("\0");
    const changes = [];
    for (let i = 0; i < rows.length - 1; i += 2)
      changes.push({ status: rows[i], file: rows[i + 1] });
    const result = selectChanges(graph, changes);
    assert.equal(result.full, true, merge);
    assert.deepEqual(enabled(result), allJobs, merge);
  }
});

test("main, nightly, queue and manual events always run full; missing or corrupt bases fail open", async () => {
  for (const event of ["push", "schedule", "merge_group", "workflow_dispatch", undefined])
    assert.equal((await selection(root, { GITHUB_EVENT_NAME: event })).full, true);
  assert.equal(
    (
      await selection(root, {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: "/does-not-exist",
      })
    ).full,
    true,
  );
  assert.equal(
    (await selection(root, { GITHUB_EVENT_NAME: "pull_request", CI_FORCE_FULL: "true" })).full,
    true,
  );
  assert.throws(() => changedFiles(root, "bad"), /missing base/);
  assert.throws(() => changedFiles(root, "0".repeat(40)));
});

test("runners union critical files before filtering, keep integration coverage and propagate failures", () => {
  const result = selected("packages/app/src/chi/reply-model.test.ts");
  for (const pkg of Object.keys(critical)) {
    const argv = new Set(commands(pkg, result).flat());
    for (const file of critical[pkg]) assert.ok(argv.has(file), `${pkg}/${file}`);
    assert.ok(!argv.has("--changed") && !argv.has("--related") && !argv.has("--passWithNoTests"));
  }
  for (const mode of [result, fullSelection("main")]) {
    assert.ok(commands("server", mode).flat().includes(criticalServerIntegration[0]));
  }
  assert.ok(commands("server", fullSelection("main")).flat().includes("test:integration"));
  assert.ok(
    commands("server", selected("packages/server/src/server/auth.ts"))
      .flat()
      .includes("test:integration"),
  );
  assert.deepEqual(commands("relay", result), []);
  assert.throws(
    () => commands("app", { ...result, tests: { app: ["$(false)"] } }),
    /invalid selection/,
  );
  assert.throws(() => commands("unowned", result), /unknown suite/);
});

test("CLI critical union precedes lossless disjoint partition; empty shards succeed", () => {
  const files = graph.files
    .filter((file) => /^packages\/cli\/tests\/\d{2}-.*\.test\.ts$/.test(file))
    .map((file) => file.split("/").at(-1));
  const narrow = cliFiles(files, selected("packages/app/src/chi/reply-model.test.ts"));
  assert.deepEqual(narrow, [...criticalCli].sort());
  for (const count of [1, 3, 4, 8]) {
    const buckets = partition(narrow, count, [criticalCli[0]]);
    assert.deepEqual(buckets.flat().sort(), narrow);
    assert.equal(new Set(buckets.flat()).size, narrow.length);
  }
  assert.deepEqual(cliFiles(files, fullSelection("main")), files);
  assert.deepEqual(cliFiles(files, selected("packages/server/src/server/auth.ts")), files);
  assert.deepEqual(
    cliFiles(
      files.filter((file) => file !== criticalCli[0]),
      selected("packages/app/src/chi/reply-model.test.ts"),
    ),
    files.filter((file) => file !== criticalCli[0]),
  );
  assert.throws(() => partition(["a", "a"], 3));
  assert.throws(() => partition(["a"], 0));
  const runner = readFileSync(new URL("../packages/cli/tests/run-all.ts", import.meta.url), "utf8");
  assert.match(runner, /if \(testFiles.length === 0\) \{[\s\S]*?process.exit\(0\)/);
  assert.match(runner, /process.exit\(failed > 0 \? 1 : 0\)/);
});

function fixture(t) {
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "ci-graph-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = new Set();
  function write(file, contents) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(
      join(directory, file),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
    files.add(file);
  }
  const pkgs = [
    "server",
    "app",
    "client",
    "protocol",
    "plugin",
    "highlight",
    "relay",
    "cli",
    "desktop",
    "leaf",
    "consumer",
  ];
  write("package.json", { workspaces: pkgs.map((pkg) => `packages/${pkg}`) });
  for (const pkg of pkgs) {
    write(`packages/${pkg}/package.json`, { name: `@fixture/${pkg}` });
    write(`packages/${pkg}/tsconfig.json`, {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        paths: { "alias/*": ["./src/*"] },
      },
    });
  }
  for (const [pkg, tests] of Object.entries(critical))
    for (const file of tests) write(`packages/${pkg}/${file}`, "export {};\n");
  for (const file of criticalCli) write(`packages/cli/tests/${file}`, "export {};\n");
  for (const file of criticalServerIntegration) write(`packages/server/${file}`, "export {};\n");
  return { directory, files, write, build: () => buildGraph(directory, [...files]) };
}

test("compiler graph follows manifests, exports, aliases, references, reexports and all Metro variants", async (t) => {
  const f = fixture(t);
  f.write("packages/leaf/package.json", {
    name: "@fixture/leaf",
    exports: { ".": "./dist/index.js" },
  });
  f.write("packages/consumer/package.json", {
    name: "@fixture/consumer",
    dependencies: { "@fixture/leaf": "*" },
  });
  f.write("packages/consumer/tsconfig.json", { references: [{ path: "../leaf" }] });
  for (const variant of ["", ".native", ".web", ".electron", ".ios", ".android"])
    f.write(`packages/leaf/src/value${variant}.ts`, "export const value = 1;");
  f.write("packages/leaf/src/barrel.ts", "export { value } from 'alias/value';");
  f.write("packages/leaf/src/value.test.ts", "import {value} from './barrel.js';");
  f.write("packages/leaf/src/unrelated.test.ts", "export {};");
  f.write("packages/consumer/src/value.test.ts", "import {value} from '@fixture/leaf';");
  const g = await f.build();
  assert.ok(g.packageReverse.get("leaf").has("consumer"));
  for (const variant of ["", ".native", ".web", ".electron", ".ios", ".android"]) {
    const result = selectChanges(g, modified(`packages/leaf/src/value${variant}.ts`));
    assert.equal(result.full, false);
    assert.deepEqual(result.tests.leaf, ["src/value.test.ts"]);
    assert.deepEqual(result.tests.consumer, ["src/value.test.ts"]);
    assertCritical(result);
  }
});

test("computed loaders, subprocesses, fixtures and unresolved imports retain dependent tests", async (t) => {
  const f = fixture(t);
  f.write("packages/leaf/src/value.ts", "export const value = 1;");
  f.write("packages/leaf/src/dynamic.ts", "export const load = (file) => import(file);");
  f.write("packages/leaf/src/dynamic.test.ts", "import {load} from './dynamic.js';");
  f.write(
    "packages/leaf/src/fixture.test.ts",
    "import {readFileSync} from 'node:fs'; readFileSync('fixture.json');",
  );
  f.write("packages/leaf/src/process.test.ts", "import {spawn} from 'node:child_process';");
  f.write("packages/leaf/src/unresolved.test.ts", "import './missing-generated.js';");
  f.write("packages/leaf/src/unrelated.test.ts", "export {};");
  const result = selectChanges(await f.build(), modified("packages/leaf/src/value.ts"));
  assert.deepEqual(result.tests.leaf, [
    "src/dynamic.test.ts",
    "src/fixture.test.ts",
    "src/process.test.ts",
    "src/unresolved.test.ts",
  ]);
});

test("Sync/File process and filesystem call names are opaque without a node: import", async (t) => {
  // These files have no import at all, so the external-module fallback cannot
  // retain them. The only signal is the call name; `\bspawn\b`/`\bexec\b` do not
  // match `spawnSync`/`execFile`, which is exactly the gap being closed.
  const f = fixture(t);
  f.write("packages/leaf/src/value.ts", "export const value = 1;");
  const calls = {
    "spawnSync.test.ts": "spawnSync('echo', []);",
    "execSync.test.ts": "execSync('echo');",
    "execFile.test.ts": "execFile('echo', []);",
    "execFileSync.test.ts": "execFileSync('echo', []);",
    "readFileSync.test.ts": "readFileSync('value.json');",
    "readdirSync.test.ts": "readdirSync('.');",
  };
  for (const [file, body] of Object.entries(calls)) f.write(`packages/leaf/src/${file}`, body);
  f.write("packages/leaf/src/unrelated.test.ts", "export {};");
  const result = selectChanges(await f.build(), modified("packages/leaf/src/value.ts"));
  assert.deepEqual(
    result.tests.leaf,
    Object.keys(calls)
      .map((file) => `src/${file}`)
      .sort(),
  );
});

test("invalid graph syntax cannot create skip authority", async (t) => {
  const f = fixture(t);
  f.write("packages/leaf/src/broken.ts", "const = ???");
  await assert.rejects(f.build(), /parse failure/);
  f.write("packages/leaf/src/broken.ts", "export {};");
  f.write("packages/leaf/tsconfig.json", "{ broken");
  await assert.rejects(f.build(), /cannot read/);
});

test("diff is base versus tested merge tree, not head-only or recency; missing ancestor fails", (t) => {
  const f = fixture(t);
  const identity = execFileSync("git", ["log", "-1", "--format=%an%n%ae"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: f.directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Fixture-only commit metadata, without altering any shared Git config.
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: identity[0],
        GIT_AUTHOR_EMAIL: identity[1],
        GIT_COMMITTER_NAME: identity[0],
        GIT_COMMITTER_EMAIL: identity[1],
      },
    }).trim();
  git("init", "-q");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  f.write("packages/leaf/src/change.ts", "export const value = 1;");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "change");
  assert.deepEqual(changedFiles(f.directory, base), [
    { status: "A", file: "packages/leaf/src/change.ts" },
  ]);
});
