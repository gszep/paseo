import test from "node:test";
import assert from "node:assert/strict";
import { unapprovedFileDeps, ALLOWED_FILE_DEPENDENCY } from "./lockfile-file-deps.mjs";

test("the vendored Chi tarball is the only permitted local-file resolution", () => {
  const approved = {
    packages: {
      "node_modules/@henkaku-center/chi-native": { resolved: ALLOWED_FILE_DEPENDENCY },
      "node_modules/zod": { resolved: "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz" },
    },
  };
  assert.deepEqual(unapprovedFileDeps(approved), []);
});

test("any other local-file resolution is rejected", () => {
  const injected = {
    packages: {
      "node_modules/@henkaku-center/chi-native": { resolved: ALLOWED_FILE_DEPENDENCY },
      "node_modules/evil": { resolved: "file:vendor/evil.tgz" },
      "node_modules/also-evil": { resolved: "file:../../elsewhere/pkg.tgz" },
    },
  };
  assert.deepEqual(unapprovedFileDeps(injected), [
    "node_modules/evil -> file:vendor/evil.tgz",
    "node_modules/also-evil -> file:../../elsewhere/pkg.tgz",
  ]);
});

test("the permitted tarball path cannot be assigned to another package", () => {
  assert.deepEqual(
    unapprovedFileDeps({
      packages: {
        "node_modules/other": { resolved: ALLOWED_FILE_DEPENDENCY },
      },
    }),
    [`node_modules/other -> ${ALLOWED_FILE_DEPENDENCY}`],
  );
});
