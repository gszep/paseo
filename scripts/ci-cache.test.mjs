import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { docsOnly, classify } from "./ci-docs-only.mjs";
import { hashFiles, installInputs, validInstall } from "./ci-cache.mjs";
import { inputs, keyFor, outputs, targets, validBuild } from "./ci-build.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "paseo-ci-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const put = (name, content) => {
    mkdirSync(join(cwd, name, ".."), { recursive: true });
    writeFileSync(join(cwd, name), content);
  };
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=CI fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  return { cwd, put, git };
}

test("Markdown-only skips; code, tested documentation, HTML and SVG retain tests", () => {
  assert.equal(docsOnly(["README.md", "docs/nested/example.md", "AGENTS.md"]), true);
  for (const files of [
    [],
    ["README.md", "packages/server/src/auth.ts"],
    ["docs/map.html"],
    ["docs/architecture.svg"],
    ["CHANGELOG.md"],
    ["public-docs/plugins/migration.md"],
    ["skills/paseo-advisor/SKILL.md"],
  ])
    assert.equal(docsOnly(files), false);
});

test("classification uses tested merge tree and fails open on diff errors", (t) => {
  const { cwd, put, git } = fixture(t);
  git("init");
  put("README.md", "before");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  put("README.md", "after");
  git("add", ".");
  git("commit", "-m", "docs");
  put("event.json", JSON.stringify({ pull_request: { base: { sha: base } } }));
  const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: join(cwd, "event.json") };
  assert.deepEqual(classify(env, cwd), { skip: true, full: false });
  put("src/code.ts", "export const changed = true;");
  git("add", "src/code.ts");
  git("commit", "-m", "mixed docs and code");
  assert.deepEqual(classify(env, cwd), { skip: false, full: true });
  put("CHANGELOG.md", "tested");
  git("add", "CHANGELOG.md");
  git("commit", "-m", "tested doc");
  assert.deepEqual(classify(env, cwd), { skip: false, full: true });
  git("rm", "README.md");
  git("commit", "-m", "delete");
  assert.deepEqual(classify(env, cwd), { skip: false, full: true });
  assert.deepEqual(classify({ ...env, GITHUB_EVENT_PATH: "missing" }, cwd), {
    skip: false,
    full: true,
  });
  for (const event of ["push", "schedule", "merge_group", "workflow_dispatch"])
    assert.deepEqual(classify({ ...env, GITHUB_EVENT_NAME: event }, cwd), {
      skip: false,
      full: true,
    });
});

test("install keys include vendored bytes, nested manifests, patches and lifecycle scripts", (t) => {
  const { cwd, put } = fixture(t);
  const files = [
    "package-lock.json",
    ".npmrc",
    "packages/server/package.json",
    "vendor/native.tgz",
    "patches/sdk.patch",
    "scripts/postinstall-patches.mjs",
    "packages/protocol/scripts/generate.mjs",
    ".github/workflows/ci.yml",
    ".github/actions/ci-restore/action.yml",
  ];
  for (const file of files) put(file, "one");
  assert.deepEqual(installInputs([...files, "docs/guide.md"]), files);
  const before = hashFiles(files, cwd);
  put("vendor/native.tgz", "two");
  assert.notEqual(hashFiles(files, cwd), before);
});

test("a snapshot needs the exact patch stamp, pinned versions and valid workspace links", (t) => {
  const { cwd, put } = fixture(t);
  put(
    "node_modules/.package-lock.json",
    JSON.stringify({
      packages: {
        "": {},
        "node_modules/dependency": { version: "1.0.0" },
        "node_modules/workspace": { link: true, resolved: "packages/workspace" },
      },
    }),
  );
  put("node_modules/dependency/package.json", '{"version":"1.0.0"}');
  put("packages/workspace/package.json", '{"name":"workspace"}');
  put(
    "node_modules/.ci-install-key",
    JSON.stringify({ key: "exact", layout: hashFiles(["node_modules/.package-lock.json"], cwd) }),
  );
  symlinkSync(join(cwd, "packages/workspace"), join(cwd, "node_modules/workspace"), "junction");
  assert.equal(validInstall("exact", cwd), true);
  assert.equal(validInstall("different", cwd), false);
  const layout = readFileSync(join(cwd, "node_modules/.package-lock.json"), "utf8");
  put("node_modules/.package-lock.json", '{"packages":{}}');
  assert.equal(validInstall("exact", cwd), false);
  put("node_modules/.package-lock.json", layout);
  put("node_modules/dependency/package.json", '{"version":"2.0.0"}');
  assert.equal(validInstall("exact", cwd), false);
  put("node_modules/dependency/package.json", '{"version":"1.0.0"}');
  rmSync(join(cwd, "node_modules/workspace"));
  assert.equal(validInstall("exact", cwd), false);
});

test("build keys include transitive sources/generators/assets; unrelated app code reuses server build", (t) => {
  const { cwd, put } = fixture(t);
  const files = [
    "package.json",
    "tsconfig.json",
    "packages/server/src/server.ts",
    "packages/protocol/src/schema.ts",
    "packages/protocol/codegen/compile.ts",
    "packages/server/src/model.onnx",
    "skills/paseo-advisor/SKILL.md",
    "packages/app/src/view.tsx",
  ];
  for (const file of files) put(file, "one");
  const key = keyFor("build:server", files, "runtime", cwd);
  put("packages/app/src/view.tsx", "two");
  assert.equal(keyFor("build:server", files, "runtime", cwd), key);
  for (const file of inputs("build:server", files)) {
    put(file, "two");
    assert.notEqual(keyFor("build:server", files, "runtime", cwd), key, file);
    put(file, "one");
  }
  assert.notEqual(keyFor("build:server", files, "new-runtime", cwd), key);
});

test("missing, stale or modified outputs cannot satisfy a build stamp", (t) => {
  const { cwd, put } = fixture(t);
  put("dist/index.js", "one");
  const stamp = { key: "exact", output: hashFiles(["dist/index.js"], cwd) };
  assert.equal(validBuild(stamp, "exact", ["dist"], cwd), true);
  assert.equal(validBuild(stamp, "changed-source", ["dist"], cwd), false);
  put("dist/index.js", "corrupt");
  assert.equal(validBuild(stamp, "exact", ["dist"], cwd), false);
  rmSync(join(cwd, "dist/index.js"));
  assert.equal(validBuild(stamp, "exact", ["dist"], cwd), false);
});

test("client consumers include relay and build cleanup never owns tracked documentation", () => {
  for (const target of ["build:client", "build:plugin", "build:app-deps", "build:server"]) {
    assert.deepEqual(inputs(target, ["packages/relay/src/index.ts"]), [
      "packages/relay/src/index.ts",
    ]);
    assert.ok(!outputs(target).includes("packages/protocol/src/generated"));
  }
});

test("a new workspace dependency cannot silently escape a task's build-input closure", () => {
  for (const [target, packages] of Object.entries(targets)) {
    const queue = [...packages];
    const visited = new Set();
    while (queue.length) {
      const name = queue.pop();
      if (visited.has(name)) continue;
      visited.add(name);
      const manifest = JSON.parse(
        readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), "utf8"),
      );
      for (const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.peerDependencies,
      })) {
        if (dependency.startsWith("@getpaseo/")) queue.push(dependency.slice("@getpaseo/".length));
      }
      const file = `packages/${name}/package.json`;
      assert.ok(
        inputs(target, [file]).includes(file),
        `${target} is missing ${name}; expand the cache inputs`,
      );
    }
  }
});
