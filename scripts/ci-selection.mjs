import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { critical, criticalCli, criticalServerIntegration, suites } from "./ci-test-policy.mjs";
import { docsOnly } from "./ci-docs-only.mjs";

const sourcePattern = /\.[cm]?[jt]sx?$/;
const testPattern = /\.(test|spec)\.[cm]?[jt]sx?$/;
const portable = (path) => path.replaceAll("\\", "/");
const readJson = (root, file) => JSON.parse(readFileSync(resolve(root, file), "utf8"));
const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

export function closure(seeds, reverse) {
  const reached = new Set(seeds);
  for (const node of reached) for (const consumer of reverse.get(node) ?? []) reached.add(consumer);
  return reached;
}

function edge(graph, dependency, consumer) {
  if (!graph.has(dependency)) graph.set(dependency, new Set());
  graph.get(dependency).add(consumer);
}

export function inventory(root) {
  return git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
}

export function unitFiles(files, pkg) {
  const prefix = `packages/${pkg}/`;
  return files
    .filter((file) => file.startsWith(prefix) && testPattern.test(file))
    .map((file) => file.slice(prefix.length))
    .filter(
      (file) =>
        !file.startsWith("e2e/") &&
        (pkg !== "server" || !file.endsWith(".e2e.test.ts")) &&
        (pkg !== "cli" || file.startsWith("src/")) &&
        (pkg !== "app" || file.startsWith("src/") || file === "native-release-version.test.ts"),
    )
    .sort();
}

// Use the compiler's parser/resolver, including tsconfig extends/paths/references.
// No executable project configuration is evaluated by the selector.
export async function buildGraph(root, files = inventory(root)) {
  const { default: ts } = await import("typescript");
  const workspaces = readJson(root, "package.json").workspaces;
  if (!Array.isArray(workspaces) || workspaces.some((path) => !/^packages\/[\w-]+$/.test(path)))
    throw new Error("unsupported workspace layout");
  const packages = new Map(
    workspaces.map((path) => [path.split("/")[1], readJson(root, `${path}/package.json`)]),
  );
  const names = new Map([...packages].map(([pkg, manifest]) => [manifest.name, pkg]));
  const owner = (file) => [...packages.keys()].find((pkg) => file.startsWith(`packages/${pkg}/`));
  const packageReverse = new Map();
  const fileReverse = new Map();
  const opaque = new Set();
  const options = new Map();
  const tracked = new Set(files);
  packages.forEach((manifest, pkg) => {
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    })) {
      if (names.has(name)) edge(packageReverse, names.get(name), pkg);
    }
    const configName =
      /(?:^|\s)-p\s+([\w.-]+\.json)/.exec(manifest.scripts?.typecheck ?? "")?.[1] ??
      "tsconfig.json";
    const configPath = resolve(root, `packages/${pkg}/${configName}`);
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(`cannot read ${configPath}`);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
    // No-input diagnostics are irrelevant to import resolution; malformed options aren't.
    if (parsed.errors.some((error) => error.code !== 18003))
      throw new Error(`invalid tsconfig: ${pkg}`);
    options.set(pkg, parsed.options);
    for (const ref of parsed.projectReferences ?? []) {
      const dependency = owner(portable(relative(root, ref.path)) + "/");
      if (!dependency) throw new Error(`unknown project reference: ${ref.path}`);
      edge(packageReverse, dependency, pkg);
    }
  });
  function variants(file) {
    const stem = file.replace(/(?:\.(?:native|web|electron|ios|android))?\.[cm]?[jt]sx?$/, "");
    return [
      file,
      ...["", ".native", ".web", ".electron", ".ios", ".android"].flatMap((platform) =>
        [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"].map(
          (ext) => stem + platform + ext,
        ),
      ),
    ].filter((candidate) => tracked.has(candidate));
  }
  function packageInputEdges(dependency, consumerFile, consumerPackage) {
    edge(packageReverse, dependency, consumerPackage);
    for (const input of files.filter((candidate) =>
      candidate.startsWith(`packages/${dependency}/`),
    ))
      edge(fileReverse, input, consumerFile);
  }
  for (const file of files.filter(
    (candidate) => sourcePattern.test(candidate) && owner(candidate),
  )) {
    const pkg = owner(file);
    const text = readFileSync(resolve(root, file), "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if (ast.parseDiagnostics.length) throw new Error(`parse failure: ${file}`);
    const imports = new Set();
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.add(node.moduleSpecifier.text);
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      )
        imports.add(node.moduleReference.expression.text);
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(ast);
        if (
          name === "require" ||
          name === "require.resolve" ||
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          /^(vi|jest)\.(mock|doMock|importActual|importMock)$/.test(name)
        ) {
          if (node.arguments.length && ts.isStringLiteralLike(node.arguments[0]))
            imports.add(node.arguments[0].text);
          else opaque.add(file);
        }
        // Runtime/config/fixture discovery cannot establish independence.
        if (
          /\b(fetch|eval|Function|glob|readFile|readdir|spawn|exec|fork|createRequire|readFileSync)\b/.test(
            name,
          )
        )
          opaque.add(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    function resolveImport(specifier) {
      const workspaceName = [...names.keys()].find(
        (name) => specifier === name || specifier.startsWith(name + "/"),
      );
      if (workspaceName) {
        const dependency = names.get(workspaceName);
        // Published exports often resolve to generated declarations. Package edges
        // deliberately cover ALL source exports, not just a guessed dist/src map.
        packageInputEdges(dependency, file, pkg);
        return;
      }
      const resolved = ts.resolveModuleName(
        specifier,
        resolve(root, file),
        options.get(pkg),
        ts.sys,
      ).resolvedModule;
      const resolvedPath = resolved && portable(relative(root, resolved.resolvedFileName));
      const resolvedOwner = resolvedPath && owner(resolvedPath);
      if (resolvedOwner && resolvedOwner !== pkg && !tracked.has(resolvedPath)) {
        // References/aliases may resolve into a generated dist tree. The source
        // owner, not the existence of a built declaration, determines reachability.
        packageInputEdges(resolvedOwner, file, pkg);
      }
      let candidates = [];
      if (resolved && !resolved.isExternalLibraryImport)
        candidates = variants(portable(relative(root, resolved.resolvedFileName)));
      // TypeScript may not resolve Metro-only modules, or assets. Union every
      // platform variant even when the compiler resolved a base implementation.
      let local = specifier.startsWith(".")
        ? posix.normalize(posix.join(posix.dirname(file), specifier))
        : undefined;
      if (specifier.startsWith("@/")) local = `packages/app/src/${specifier.slice(2)}`;
      if (specifier.startsWith("@server/")) local = `packages/server/src/${specifier.slice(8)}`;
      if (local) {
        candidates.push(
          ...variants(local),
          ...variants(local + ".ts"),
          ...variants(local + "/index.ts"),
        );
        if (tracked.has(local)) candidates.push(local);
      }
      for (const dependency of new Set(candidates)) {
        edge(fileReverse, dependency, file);
        const dependencyOwner = owner(dependency);
        if (dependencyOwner && dependencyOwner !== pkg) edge(packageReverse, dependencyOwner, pkg);
      }
      // External modules can perform I/O too. Only the test framework and type-only
      // modules have no project runtime inputs we need to trace. Retain consumers
      // of every other opaque dependency whenever this package is affected.
      if (!candidates.length && specifier !== "vitest") opaque.add(file);
    }
    for (const specifier of imports) resolveImport(specifier);
  }
  return {
    root,
    files,
    packages,
    owner,
    packageReverse,
    fileReverse,
    opaqueTests: closure(opaque, fileReverse),
  };
}

export function fullSelection(reason) {
  return {
    full: true,
    reason,
    jobs: Object.fromEntries(
      ["format", "quality", ...Object.keys(suites)].map((job) => [job, true]),
    ),
    tests: {},
    packages: [],
  };
}

export function criticalSelection(root) {
  const files = inventory(root);
  const packages = new Map(
    readJson(root, "package.json").workspaces.map((path) => [path.split("/")[1], null]),
  );
  const uncertain = criticalUncertainty(files, packages);
  if (uncertain) return uncertain;
  return {
    full: false,
    reason: "documentation: critical contracts only",
    packages: [],
    jobs: {
      format: false,
      quality: false,
      server: true,
      app: true,
      sdk: true,
      cli: true,
      browser: false,
      desktop: false,
      relay: false,
    },
    tests: Object.fromEntries(
      [...packages.keys()].map((pkg) => [pkg, [...(critical[pkg] ?? [])].sort()]),
    ),
  };
}

function selectionUncertainty(graph, changes) {
  const { files, packages, owner } = graph;
  const tracked = new Set(files);
  if (!changes.length) return fullSelection("empty diff");
  for (const { status, file } of changes) {
    if (status !== "M" || !tracked.has(file))
      return fullSelection("new, deleted, renamed or unknown path");
    if (
      testPattern.test(file) &&
      !unitFiles(files, owner(file)).includes(file.slice(`packages/${owner(file)}/`.length))
    )
      return fullSelection("non-unit harness input");
    // Configuration, helpers, fixtures, assets, lockfiles, tarballs and scripts
    // can be read without an import. Narrow ONLY established source/test paths.
    if (
      !/^packages\/[^/]+\/src\//.test(file) ||
      !sourcePattern.test(file) ||
      /(?:^|\/)(?:test-utils|test-stubs|helpers|support|fixtures|__fixtures__|__mocks__|generated)(?:\/|$)|(?:config|setup|test-helper)\.[cm]?[jt]s$/.test(
        file,
      )
    )
      return fullSelection("runtime/configuration/fixture input");
  }
  return criticalUncertainty(files, packages);
}

function criticalUncertainty(files, packages) {
  const tracked = new Set(files);
  for (const [pkg, paths] of Object.entries(critical)) {
    if (!packages.has(pkg) || paths.some((path) => !unitFiles(files, pkg).includes(path)))
      return fullSelection("stale critical manifest");
  }
  for (const file of [
    ...criticalServerIntegration.map((path) => `packages/server/${path}`),
    ...criticalCli.map((path) => `packages/cli/tests/${path}`),
  ]) {
    if (!tracked.has(file)) return fullSelection("stale critical integration manifest");
  }
}

export function selectChanges(graph, changes) {
  const uncertain = selectionUncertainty(graph, changes);
  if (uncertain) return uncertain;
  const { files, owner, packages, packageReverse, fileReverse, opaqueTests } = graph;
  const changed = changes.map(({ file }) => file);
  const reached = closure(changed, fileReverse);
  const sourceOwners = new Set([...reached].filter((file) => !testPattern.test(file)).map(owner));
  if (changed.some((file) => !owner(file))) return fullSelection("unknown package");
  const affected = closure(sourceOwners, packageReverse);
  const tests = {};
  for (const pkg of packages.keys()) {
    const all = unitFiles(files, pkg);
    const direct = changed.some((file) => owner(file) === pkg);
    const selected = new Set(critical[pkg] ?? []);
    for (const file of all) {
      const path = `packages/${pkg}/${file}`;
      if (
        (affected.has(pkg) && !sourceOwners.has(pkg)) ||
        reached.has(path) ||
        ((direct || affected.has(pkg)) && opaqueTests.has(path)) ||
        // Vitest browser tests use websocket-test-global-setup to start a daemon.
        (pkg === "app" && affected.has("server") && file.includes(".browser."))
      )
        selected.add(file);
    }
    tests[pkg] = [...selected].sort();
  }
  const jobs = { format: true, quality: true };
  for (const [job, owners] of Object.entries(suites)) {
    jobs[job] = owners.some((pkg) => affected.has(pkg) || tests[pkg]?.length);
  }
  // Critical units do not imply that unrelated process/browser harnesses changed.
  jobs.browser = suites.browser.some((pkg) => affected.has(pkg));
  jobs.desktop = suites.desktop.some((pkg) => affected.has(pkg)) || tests.desktop.length > 0;
  jobs.cli = true; // critical CLI permission/auth contracts, unioned before sharding
  return { full: false, reason: "dependency graph", jobs, tests, packages: [...affected].sort() };
}

export function changedFiles(root, base) {
  if (!/^[a-f0-9]{40}$/.test(base ?? "")) throw new Error("missing base SHA");
  git(root, ["merge-base", "--is-ancestor", base, "HEAD"]);
  const rows = git(root, ["diff", "--name-status", "--no-renames", "-z", base, "HEAD"]).split("\0");
  const changes = [];
  for (let i = 0; i < rows.length - 1; i += 2) changes.push({ status: rows[i], file: rows[i + 1] });
  return changes;
}

export async function selection(root = process.cwd(), env = process.env) {
  try {
    if (env.GITHUB_EVENT_NAME !== "pull_request" || env.CI_FORCE_FULL === "true")
      return fullSelection("non-PR or forced full run");
    const event = readJson(root, env.GITHUB_EVENT_PATH);
    const changes = changedFiles(root, event.pull_request.base.sha);
    if (
      changes.every(({ status }) => status === "M" || status === "A") &&
      docsOnly(changes.map(({ file }) => file))
    )
      return criticalSelection(root);
    // Global changes need neither an installed compiler nor a built workspace.
    if (
      changes.some(
        ({ status, file }) =>
          status !== "M" || !/^packages\/[^/]+\/src\/.*\.[cm]?[jt]sx?$/.test(file),
      )
    )
      return fullSelection("global or unknown input");
    return selectChanges(await buildGraph(root), changes);
  } catch (error) {
    return fullSelection(`uncertain: ${error.message}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await selection();
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `full=${result.full}\n` +
        Object.entries(result.jobs)
          .map(([name, value]) => `${name}=${value}\n`)
          .join(""),
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Test selection\n\n${result.reason}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`,
    );
}
