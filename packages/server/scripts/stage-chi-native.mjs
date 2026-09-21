import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// npm pack does not collect a workspace's hoisted bundled dependency. Stage the
// locked installed package locally so the ordinary npm bundle includes its JS
// and declarations. No dependency archive path is needed by the installed server.
const root = new URL("../../../package.json", import.meta.url);
const require = createRequire(root);
const source = resolve(
  dirname(require.resolve("@henkaku-center/chi-native/continuation")),
  "../../..",
);
const manifest = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"));
if (
  manifest.name !== "@henkaku-center/chi-native" ||
  Object.keys(manifest.dependencies ?? {}).length
) {
  throw new Error("Chi native bundle must contain its complete dependency closure");
}
const target = fileURLToPath(
  new URL("../node_modules/@henkaku-center/chi-native", import.meta.url),
);
await mkdir(dirname(target), { recursive: true });
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
