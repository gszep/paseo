import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const connection = "src/server/chi/connection.ts";
const capture = "src/server/chi/append-capture.ts";
const mentions = "src/server/chi/mentions.ts";
const cases = [
  [
    "native workspace binding",
    capture,
    "location.directory !== input.cwd",
    "false",
    "connection",
    "misbound native checkout",
  ],
  [
    "catalog delivery fence",
    connection,
    "this.requireMentionContext(await identity(), context);",
    "",
    "connection",
    "delayed repository catalog",
  ],
  [
    "append capability",
    connection,
    "appendLog: z.object({ v: z.literal(3)",
    "appendLog: z.object({ v: z.number()",
    "connection",
    "refuses absent/unknown",
  ],
  [
    "mention capability",
    connection,
    'references: z.literal("pin-seq")',
    "references: z.string()",
    "connection",
    "refuses absent/unknown",
  ],
  [
    "cut scan",
    capture,
    "const verdict = await scan(batch.full, batch.minimised);",
    'const verdict = { verdict: "clean" };',
    "append-capture",
    "cut-scan rejection",
  ],
  [
    "delta-only scan",
    capture,
    "projection(native.messages.slice(start, end))",
    "projection(native.messages.slice(0, end))",
    "append-capture",
    "only new messages",
  ],
  [
    "late actor",
    connection,
    "!sameActor(current.chiUserId, auth.chiUserId)",
    "false",
    "connection",
    "host identity changed",
  ],
  [
    "late association",
    connection,
    "!sameCaptureScope(current, pinned)",
    "false",
    "connection",
    "newly scoped association",
  ],
  [
    "message ordinal",
    mentions,
    'entry.kind !== "message" || entry.seq !== selected.seq',
    "entry.seq !== selected.seq",
    "mentions",
    "metadata ordinal",
  ],
  [
    "scoped outbox",
    mentions,
    "receipt.deployment === identity.deployment &&",
    "",
    "mentions",
    "another actor's local outbox",
  ],
  [
    "foreign pin",
    mentions,
    "input.pin.deployment !== input.identity.deployment",
    "false",
    "mentions",
    "cross-deployment pin",
  ],
];
function run(file, pattern) {
  return spawnSync(
    process.execPath,
    [
      root + "node_modules/vitest/vitest.mjs",
      "run",
      `src/server/chi/${file}.test.ts`,
      "--bail=1",
      "-t",
      pattern,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
}
// Each changed file's targeted baseline must pass before guard mutation. The
// normal unit script already exercises the rest of these suites before this gate.
for (const file of new Set(cases.map((item) => item[4]))) {
  const baseline = run(
    file,
    cases
      .filter((item) => item[4] === file)
      .map((item) => item[5])
      .join("|"),
  );
  if (baseline.status !== 0)
    throw new Error(`Baseline failed: ${file}\n${baseline.stdout}\n${baseline.stderr}`);
}
for (const [name, file, before, after, suite, pattern] of cases) {
  const path = root + file;
  const source = await readFile(path, "utf8");
  if (!source.includes(before)) throw new Error(`Missing mutation target: ${name}`);
  const mutant = source.replace(before, after);
  const syntax = ts.transpileModule(mutant, { fileName: path, reportDiagnostics: true });
  if (syntax.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error))
    throw new Error(`Invalid mutant: ${name}`);
  try {
    await writeFile(path, mutant);
    const result = run(suite, pattern);
    if (result.status === 0 || result.signal || result.error)
      throw new Error(
        `Mutation survived or timed out: ${name}\n${result.stdout}\n${result.stderr}`,
      );
    console.log(`killed: ${name}`);
  } finally {
    await writeFile(path, source);
  }
}
console.log(`${cases.length}/${cases.length} Chi scanner/auth/ACL mutations detected`);
