import { criticalCli } from "./ci-test-policy.mjs";

export function partition(files, count, heavy = []) {
  if (!Number.isInteger(count) || count < 1 || new Set(files).size !== files.length)
    throw new Error("invalid partition input");
  const buckets = Array.from({ length: count }, () => []);
  const weights = new Set(heavy);
  const slow = files.filter((file) => weights.has(file)).sort();
  const other = files.filter((file) => !weights.has(file)).sort();
  slow.forEach((file, index) => buckets[index % count].push(file));
  other.forEach((file, index) => buckets[count - 1 - (index % count)].push(file));
  const union = buckets.flat().sort();
  if (JSON.stringify(union) !== JSON.stringify([...files].sort()))
    throw new Error("partition lost tests");
  return buckets;
}

export function cliFiles(files, selected) {
  // The CLI harness starts the built daemon. Until it exposes finer runtime
  // reachability, a change in either package retains ALL local E2E contracts.
  if (selected.full || selected.packages.some((pkg) => pkg === "server" || pkg === "cli"))
    return files;
  if (criticalCli.some((file) => !files.includes(file))) return files;
  return [...new Set(criticalCli)].sort();
}
