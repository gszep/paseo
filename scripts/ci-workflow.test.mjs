import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import test from "node:test";
import { createHash } from "node:crypto";
import { compileFunction } from "node:vm";

const root = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const source = read(".github/workflows/ci.yml");
export const contexts = [
  "changes",
  "format",
  "lint",
  "typecheck",
  "server-tests (ubuntu-latest, opencode-ai@1.14.46)",
  "server-tests (ubuntu-latest, @opencode/cli@2.0.10)",
  "desktop-tests (ubuntu-latest)",
  "app-tests",
  "sdk-tests",
  "relay-tests",
  ...[1, 2, 3, 4].map((n) => `playwright (shard ${n}/4)`),
  ...[1, 2, 3].map((n) => `cli-tests (shard ${n}/3)`),
];

function jobs(text = source) {
  text = text.split("\njobs:\n")[1];
  return new Map(
    [...text.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  );
}

// The changes job runs these contracts before dependency installation. Parse
// the workflow's scalar/inline-list needs and scalar if fields without a YAML
// package; reject unsupported shapes instead of silently missing an edge.
function schedulingJobs() {
  return new Map(
    [...jobs()]
      .filter(([id]) => id !== "changes")
      .map(([id, block]) => {
        const dependencies = [...block.matchAll(/^    needs: (.+)$/gm)];
        const conditions = [...block.matchAll(/^    if: (.+)$/gm)];
        assert.equal(dependencies.length, 1, `${id}: one needs field`);
        assert.equal(conditions.length, 1, `${id}: one condition`);
        const raw = dependencies[0][1];
        assert.match(raw, /^(?:[\w-]+|\[[\w-]+(?:, [\w-]+)*\])$/);
        const needs = raw.startsWith("[") ? raw.slice(1, -1).split(", ") : [raw];
        assert.equal(new Set(needs).size, needs.length, `${id}: duplicate dependency`);
        const condition = conditions[0][1];
        assert.ok(condition.startsWith("${{ ") && condition.endsWith(" }}"));
        // These are trusted, reviewed workflow expressions, not event-provided code.
        // The existing expression subset is JS-compatible except the hyphenated key.
        const evaluate = compileFunction(
          `return (${condition.slice(4, -3).replaceAll(".docs-only", '["docs-only"]')});`,
          ["needs", "github", "cancelled"],
        );
        return [id, { needs, condition, evaluate }];
      }),
  );
}

const chains = [
  [
    "typecheck",
    "server-tests-ubuntu-v2",
    "desktop-tests-ubuntu",
    "app-tests",
    "playwright-1",
    "playwright-3",
    "cli-tests-1",
    "cli-tests-3",
    "format",
  ],
  [
    "server-tests-ubuntu",
    "server-tests-windows",
    "server-tests-windows-v2",
    "desktop-tests-windows",
    "sdk-tests",
    "playwright-2",
    "playwright-4",
    "cli-tests-2",
    "relay-tests",
    "lint",
  ],
];

test("parsed job DAG has width exactly two, independent of terminal job outcomes", () => {
  const graph = schedulingJobs();
  assert.equal(graph.size, 19);
  assert.deepEqual([...graph.keys()].sort(), chains.flat().sort());
  const ancestors = new Map();
  function visit(id, visiting = new Set()) {
    if (id === "changes") return new Set();
    assert.ok(graph.has(id), `unknown dependency: ${id}`);
    assert.ok(!visiting.has(id), `dependency cycle: ${id}`);
    if (ancestors.has(id)) return ancestors.get(id);
    const next = new Set(visiting).add(id);
    const reached = new Set(graph.get(id).needs);
    for (const dependency of graph.get(id).needs)
      for (const ancestor of visit(dependency, next)) reached.add(ancestor);
    ancestors.set(id, reached);
    return reached;
  }
  for (const chain of chains)
    for (const [index, id] of chain.entries()) {
      assert.deepEqual(graph.get(id).needs, index ? ["changes", chain[index - 1]] : ["changes"]);
      visit(id);
    }
  const incomparable = (a, b) => !ancestors.get(a).has(b) && !ancestors.get(b).has(a);
  const ids = [...graph.keys()];
  assert.ok(incomparable(chains[0][0], chains[1][0]), "both lanes can start; not one serial chain");
  // Any simultaneously running set is an antichain. No antichain of size three
  // proves the two-job bound for every success/failure/skip completion ordering.
  for (let a = 0; a < ids.length; a++)
    for (let b = a + 1; b < ids.length; b++)
      for (let c = b + 1; c < ids.length; c++)
        assert.ok(
          !(
            incomparable(ids[a], ids[b]) &&
            incomparable(ids[a], ids[c]) &&
            incomparable(ids[b], ids[c])
          ),
          `${ids[a]}, ${ids[b]}, ${ids[c]} escape the budget`,
        );
});

test("scheduling changes no names, steps, selection, resources, timeouts, triggers or cancellation policy", () => {
  // Frozen 5679d8e2 workflow, normalized only for the scheduling fields changed
  // here. A future execution-policy change requires explicit baseline review.
  const unchanged = source
    .replace(/^    needs: .*\n/gm, "")
    .replaceAll("!cancelled() && needs.changes.result == 'success' &&", "!cancelled() &&");
  assert.equal(
    createHash("sha256").update(unchanged).digest("hex"),
    "6bcb758595a722ce16848a9d6055509d04174c4b7f2d9d44f6743d22c4d659e0",
  );
});

function combinations(dimensions) {
  let tuples = [[]];
  for (const values of dimensions) {
    const next = [];
    for (const tuple of tuples) for (const value of values) next.push([...tuple, value]);
    tuples = next;
  }
  return tuples;
}

test("selected successors survive failed/skipped predecessors, require successful changes, and stop on workflow cancellation", () => {
  const graph = schedulingJobs();
  const states = ["success", "failure", "skipped", "cancelled"];
  const scenarios = combinations([
    states,
    states,
    [false, true],
    ["pull_request", "push", "merge_group", "schedule", "workflow_dispatch"],
    [false, true],
    ["true", "false", undefined],
    ["true", "false", undefined],
    ["true", "false", undefined],
  ]);
  for (const [id, job] of graph) {
    const baseline = compileFunction(
      `return (${job.condition.slice(4, -3).replace("needs.changes.result == 'success' && ", "").replaceAll(".docs-only", '["docs-only"]')});`,
      ["needs", "github", "cancelled"],
    );
    for (const [
      changes,
      predecessor,
      cancelled,
      event,
      draft,
      full,
      selected,
      docsOnlyOutput,
    ] of scenarios) {
      const outputs = Object.fromEntries(
        [
          "format",
          "quality",
          "server",
          "desktop",
          "app",
          "sdk",
          "browser",
          "relay",
          "cli",
          "docs-only",
        ].map((key) => [key, selected]),
      );
      outputs.full = full;
      outputs["docs-only"] = docsOnlyOutput;
      const needs = Object.fromEntries(
        job.needs.map((dependency) => [
          dependency,
          { result: dependency === "changes" ? changes : predecessor, outputs },
        ]),
      );
      const github = { event_name: event, event: { pull_request: { draft } } };
      const expected = changes === "success" && baseline(needs, github, () => cancelled);
      assert.equal(
        job.evaluate(needs, github, () => cancelled),
        expected,
        `${id}/${changes}/${predecessor}/${cancelled}/${event}/${draft}/${full}/${selected}/${docsOnlyOutput}`,
      );
    }
  }
});

test("all required names remain static, with fail-open gating and no workflow path filters", () => {
  const trigger = source.split("jobs:")[0];
  assert.match(trigger, /merge_group:/);
  assert.match(trigger, /schedule:\s*\n\s*- cron:/);
  assert.doesNotMatch(trigger, /paths-ignore|paths:/);
  assert.doesNotMatch(source, /matrix:|dorny\/paths-filter|ci-paths\.yml/);
  assert.equal(existsSync(new URL(".github/ci-paths.yml", root)), false);
  assert.equal(contexts.length, 17);
  for (const name of contexts) assert.ok(source.includes(`    name: ${name}\n`), name);
  for (const [id, block] of jobs()) {
    if (id === "changes") continue;
    assert.ok(schedulingJobs().get(id).needs.includes("changes"));
    assert.match(block, /!cancelled\(\)/);
    assert.match(block, /needs\.changes\.outputs\.full != 'false'/);
    if (/^(server-tests|app-tests|sdk-tests|cli-tests)/.test(id)) {
      assert.doesNotMatch(block.split("runs-on:")[0], /docs-only|pull_request\.draft/);
    } else {
      assert.match(block, /github\.event_name != 'pull_request'/);
      assert.match(block, /needs\.changes\.outputs\.docs-only != 'true'/);
      assert.match(block, /!github\.event\.pull_request\.draft/);
    }
  }
});

test("selection authority is published only after classifier and soundness contracts", () => {
  const changes = jobs().get("changes");
  assert.match(changes, /scripts\/ci-docs-only\.mjs/);
  assert.match(changes, /scripts\/ci-selection\.mjs/);
  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.ok(
    changes.indexOf("Publish verified classification") >
      changes.indexOf("Verify selection soundness"),
  );
  assert.match(
    changes,
    /SKIP:.*steps\.docs\.outcome == 'success' && steps\.filter\.outcome == 'success'/,
  );
  assert.match(
    changes,
    /FULL:.*steps\.docs\.outcome != 'success' \|\| steps\.filter\.outcome != 'success'/,
  );
  assert.match(changes, /steps\.filter\.outputs\.full != 'false'/);
  assert.match(source, /full: \$\{\{ steps\.classified\.outputs\.full \}\}/);
});

test("every selected test runner inherits global fail-open authority", () => {
  const steps = source.split(/      - /);
  for (const step of steps.filter((candidate) =>
    /run: (?:node scripts\/ci-run-tests|npm run test:local)/.test(candidate),
  )) {
    assert.match(step, /CI_FORCE_FULL: \$\{\{ needs\.changes\.outputs\.full != 'false' \}\}/);
  }
  for (const pkg of [
    "server",
    "app",
    "protocol",
    "client",
    "plugin",
    "highlight",
    "relay",
    "cli",
  ]) {
    assert.match(source, new RegExp(`node scripts/ci-run-tests\\.mjs ${pkg}\\n`));
  }
  for (const id of [
    "server-tests-ubuntu",
    "app-tests",
    "sdk-tests",
    "relay-tests",
    "cli-tests-1",
  ]) {
    assert.match(jobs().get(id), /fetch-depth: 0|git fetch --no-tags --unshallow/);
  }
});

test("cross-process suites and Windows execution remain intact", () => {
  const desktop = jobs().get("desktop-tests-ubuntu");
  for (const command of [
    "test:e2e:lifecycle",
    "test:e2e:renderer",
    "test:e2e:browser-tabs",
    "npm run test --workspace=@getpaseo/desktop",
  ])
    assert.ok(desktop.includes(command));
  assert.match(source, /steps: \*desktop_test_steps/);
  assert.match(source, /steps: \*server_test_steps/);
  assert.match(jobs().get("playwright-1"), /test:e2e --workspace=@getpaseo\/app -- --shard=/);
  const config = JSON.parse(read("packages/server/tsconfig.server.json"));
  assert.ok(config.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!config.exclude.includes("src/server/test-utils/**"));
});

test("main-only immutable cache writers survive routing changes", () => {
  assert.match(source, /cancel-in-progress:.*github\.ref != 'refs\/heads\/main'/);
  for (const action of ["ci-restore", "ci-save"]) {
    const content = read(`.github/actions/${action}/action.yml`);
    assert.doesNotMatch(content, /actions\/cache@/);
    if (action === "ci-save")
      assert.equal(
        (content.match(/uses: actions\/cache\/save/g) ?? []).length,
        (content.match(/if: github\.ref == 'refs\/heads\/main'/g) ?? []).length,
      );
  }
  const save = read(".github/actions/ci-save/action.yml");
  const browser = save.split(/    - /).find((step) => /key: browsers-/.test(step));
  const writer = /github\.job == '([a-z0-9-]+)'/.exec(browser)[1];
  const steps = jobs()
    .get(writer)
    .split(/      - /);
  const install = steps.findIndex((step) =>
    /run: npx playwright install (?:--with-deps )?chromium\b/.test(step),
  );
  assert.ok(
    install >= 0 &&
      steps.findIndex((step) => /uses: \.\/\.github\/actions\/ci-save/.test(step)) > install,
  );
  assert.doesNotMatch(steps[install], /\bif:|continue-on-error:/);
  assert.match(
    save.split(/    - /).find((step) => /key: build-/.test(step)),
    /github\.job != 'format' && github\.job != 'lint'/,
  );
});

test("suite directory ownership and cross-package compatibility contracts survive", () => {
  for (const pkg of ["app", "desktop"]) {
    const files = readdirSync(new URL(`packages/${pkg}/e2e/`, root), { recursive: true }).filter(
      (file) => file.endsWith(".spec.ts"),
    );
    assert.ok(files.length);
    if (pkg === "app") assert.ok(files.every((file) => file.startsWith("browser/")));
  }
  assert.match(
    JSON.parse(read("packages/desktop/package.json")).scripts.test,
    /--exclude ["']e2e\/\*\*["']/,
  );
  assert.match(
    read("packages/protocol/src/messages.wire-compat.test.ts"),
    /wire schema compatibility/,
  );
});

test("packaging and cancellation contracts remain intact", () => {
  for (const file of ["ci", "docker", "nix"])
    assert.doesNotMatch(read(`.github/workflows/${file}.yml`), /\$\{\{\s*always\(\)/);
  for (const file of ["docker", "nix"]) {
    const text = read(`.github/workflows/${file}.yml`);
    assert.match(text.split("jobs:")[0], /push:\s*\n\s+branches: \[main\]/);
    assert.doesNotMatch(text.split("jobs:")[0], /pull_request/);
    assert.doesNotMatch(text, /dorny\/paths-filter/);
  }
  const desktop = read(".github/workflows/desktop-packages.yml");
  assert.match(desktop, /pull_request:\s*\n\s+branches: \[main\]\s*\n\s+paths:/);
  assert.match(desktop, /- "packages\/desktop\/\*\*"/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"])
    assert.match(desktop, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
});
