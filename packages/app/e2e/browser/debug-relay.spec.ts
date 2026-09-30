import { expect } from "@playwright/test";
import { daemonTest } from "../support/fixtures";

daemonTest("debug e2eWorkerClient import", async ({ e2eWorkerClient }) => {
  console.log("DEBUG_CLIENT", typeof e2eWorkerClient.fetchWorkspaces);
  expect(typeof e2eWorkerClient.fetchWorkspaces).toBe("function");
});
