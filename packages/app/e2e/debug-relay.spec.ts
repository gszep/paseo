import { test } from "@playwright/test";
import { loadDaemonClientConstructor } from "./support/helpers/daemon-client-loader";

test("debug relay import in a Playwright worker", async () => {
  try {
    const Ctor = await loadDaemonClientConstructor();
    console.log("DEBUG_LOADED", typeof Ctor);
  } catch (error) {
    console.log("DEBUG_LOADERR", (error as Error).message);
    console.log("DEBUG_STACK", (error as Error).stack);
    throw error;
  }
});
