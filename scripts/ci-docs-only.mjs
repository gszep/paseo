import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function testedDoc(file) {
  return file === "CHANGELOG.md" || /^(public-docs|skills)\//.test(file);
}

export function docsOnly(files) {
  // Changelog, plugin examples, Hub docs and runtime skills have executable
  // contracts. Conservatively retain the full routing path for these documents.
  return files.length > 0 && files.every((file) => file.endsWith(".md") && !testedDoc(file));
}

export function classify(env = process.env, cwd = process.cwd()) {
  if (env.GITHUB_EVENT_NAME !== "pull_request") return { skip: false, full: true };
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const base = event.pull_request.base.sha;
    if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("missing base");
    const rows = execFileSync(
      "git",
      ["diff", "--name-status", "--no-renames", "-z", base, "HEAD"],
      { cwd, encoding: "utf8" },
    ).split("\0");
    const files = [];
    for (let i = 0; i < rows.length - 1; i += 2) {
      if (!["A", "M"].includes(rows[i])) throw new Error("deleted/renamed/type-changed path");
      files.push(rows[i + 1]);
    }
    const mixed =
      files.some((file) => file.endsWith(".md")) && files.some((file) => !file.endsWith(".md"));
    return { skip: docsOnly(files), full: files.some(testedDoc) || files.length === 0 || mixed };
  } catch (error) {
    console.warn(`Docs classification uncertain; run everything: ${error.message}`);
    return { skip: false, full: true };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = classify();
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries(result))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
