import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["debug-relay.spec.ts"],
  reporter: [["list"]],
  timeout: 30_000,
});
