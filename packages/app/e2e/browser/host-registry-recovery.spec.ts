import { expect, test } from "../support/fixtures";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  seedLongMockAgentTimeline,
  openAgentTimeline,
  expectTimelinePromptVisible,
} from "../support/helpers/timeline-pagination";
import {
  disconnectViewedTimeline,
  restoreViewedTimelineWithHeldResponse,
} from "../support/helpers/timeline-resume";
import { composerLocator } from "../support/helpers/composer";

test.use({ viewport: { width: 390, height: 844 } });

test("a registry read failure stays on recovery and Retry loads the existing paired host", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === "@paseo:daemon-registry" && !sessionStorage.getItem("registry-test-readable")) {
        throw new DOMException("Synthetic storage denial", "SecurityError");
      }
      return getItem.call(this, key);
    };
  });
  await page.goto("/");
  await expect(page.getByTestId("host-registry-error")).toBeVisible();
  await expect(page.getByTestId("host-registry-error")).toContainText("has not been changed");
  await page.screenshot({ path: testInfo.outputPath("read-error.png") });
  await page.evaluate(() => sessionStorage.setItem("registry-test-readable", "1"));
  const registry = await page.evaluate(() => localStorage.getItem("@paseo:daemon-registry"));
  expect(registry).not.toBeNull();
  await page.getByTestId("host-registry-retry").click();
  await expect(page.getByTestId("host-registry-error")).toBeHidden();
  await expect(page).not.toHaveURL(/welcome/);
  expect(await page.evaluate(() => localStorage.getItem("@paseo:daemon-registry"))).toBe(registry);
  await page.screenshot({ path: testInfo.outputPath("read-recovered.png") });
});

test("an unknown-field host cannot erase its valid neighbour during reload", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const raw = await page.evaluate(() => {
    const hosts = JSON.parse(localStorage.getItem("@paseo:daemon-registry")!);
    hosts.push({ ...hosts[0], serverId: "srv_future_schema", unknownField: true });
    const value = JSON.stringify(hosts);
    localStorage.setItem("@paseo:daemon-registry", value);
    localStorage.setItem(
      "@paseo:e2e-disable-default-seed-once",
      localStorage.getItem("@paseo:e2e-seed-nonce")!,
    );
    return value;
  });
  await page.reload();
  await expect(page.getByTestId("host-registry-error")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("@paseo:daemon-registry"))).toBe(raw);
  await page.getByTestId("host-registry-retry").click();
  await expect(page.getByTestId("host-registry-error")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("@paseo:daemon-registry"))).toBe(raw);
  await page.screenshot({ path: testInfo.outputPath("invalid-retained.png") });
});

test("transport close retains the conversation route and unsent draft through background and reconnect", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const gate = await installDaemonWebSocketGate(page);
  const agent = await seedLongMockAgentTimeline({ turns: 2 });
  try {
    await openAgentTimeline(page, agent);
    await expectTimelinePromptVisible(page, agent.newestPrompt);
    const draft = composerLocator(page);
    await draft.fill("Keep this unsent draft during reconnect");
    const route = page.url();
    const registry = await page.evaluate(() => localStorage.getItem("@paseo:daemon-registry"));
    await disconnectViewedTimeline(page, gate);
    expect(page.url()).toBe(route);
    await expect(draft).toHaveValue("Keep this unsent draft during reconnect");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await restoreViewedTimelineWithHeldResponse(page, gate);
    expect(page.url()).toBe(route);
    await expect(draft).toHaveValue("Keep this unsent draft during reconnect");
    expect(await page.evaluate(() => localStorage.getItem("@paseo:daemon-registry"))).toBe(
      registry,
    );
    await expectTimelinePromptVisible(page, agent.newestPrompt);
    await page.screenshot({ path: testInfo.outputPath("conversation-reconnected.png") });
  } finally {
    gate.restore();
    await agent.cleanup();
  }
});
