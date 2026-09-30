import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The only local-file resolution a clean lockfile may contain. */
export const ALLOWED_FILE_DEPENDENCY = "file:vendor/henkaku-center-chi-native-0.0.0.tgz";

/**
 * `lockfile-lint` cannot scope `file:` to one path. This returns every
 * `resolved: file:` entry that is not exactly the vendored Chi tarball, so any
 * other local-file resolution fails instead of inheriting the exception.
 */
export function unapprovedFileDeps(lockfile) {
  const packages = lockfile?.packages ?? {};
  const unapproved = [];
  for (const [name, entry] of Object.entries(packages)) {
    const resolved = entry?.resolved;
    if (
      typeof resolved === "string" &&
      resolved.startsWith("file:") &&
      (resolved !== ALLOWED_FILE_DEPENDENCY || name !== "node_modules/@henkaku-center/chi-native")
    ) {
      unapproved.push(`${name} -> ${resolved}`);
    }
  }
  return unapproved;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const unapproved = unapprovedFileDeps(lockfile);
  if (unapproved.length > 0) {
    process.stderr.write(`unapproved local-file dependencies:\n${unapproved.join("\n")}\n`);
    process.exitCode = 1;
  }
}
