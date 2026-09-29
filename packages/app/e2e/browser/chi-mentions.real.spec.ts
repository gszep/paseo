import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startMentionActor } from "../support/helpers/chi-mentions";
import { composerLocator } from "../support/helpers/composer";

/**
 * Operator-approved destination for the synthetic fixture repository. The
 * endpoint equals the deployment the fixture authority wraps, so the automatic
 * association and migration both resolve to it.
 */
const CHI_CONFIG = {
  destinations: {
    henkaku: { name: "Henkaku", endpoint: "https://chi-backend-vadmp23swa-an.a.run.app" },
  },
  mappings: [
    {
      repo: "github:gszep/chi-synthetic-two-actor-20260925",
      destination: "henkaku",
      audience: "shared" as const,
    },
  ],
};

async function openActions(page: Page) {
  await page.getByTestId("workspace-header-menu-trigger").click();
  await expect(page.getByTestId("workspace-header-menu")).toBeVisible();
}
async function plainChat(page: Page) {
  const feed = page.getByTestId("conversation-chat-feed");
  await expect(feed).toBeVisible();
  await expect(
    feed.getByText(
      /Capture to Chi|Share to Chi|Future settled turns|Continue on another host|Open evidence|Open mentions|Mention context unavailable|evidence-http-/,
    ),
  ).toHaveCount(0);
  await expect(page.getByText("Open evidence", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-testid^="worktree-setup-callout-"]')).toHaveCount(0);
}

test("flat deployment inbox, unread first-view, exact deep link, clean chat and immutable replies on desktop and compact web", async ({
  browser,
}, testInfo) => {
  test.setTimeout(300000);
  const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
  const runId = randomUUID();
  const sender = await startMentionActor("sava-the-owl", origin, runId, { chi: CHI_CONFIG });
  const recipient = await startMentionActor("mochi-the-kitty", origin, runId, { chi: CHI_CONFIG });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const compact = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const sendPage = await desktop.newPage(),
    readPage = await compact.newPage();
  const compactSender = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  sendPage.setDefaultTimeout(20000);
  sendPage.setDefaultNavigationTimeout(60000);
  readPage.setDefaultNavigationTimeout(60000);
  readPage.setDefaultTimeout(20000);
  const errors: string[] = [];
  sendPage.on("pageerror", (error) => errors.push(error.message));
  readPage.on("pageerror", (error) => {
    errors.push(error.message);
    console.log("PAGEERROR", error.message);
  });
  try {
    await sender.seed(sendPage);
    await recipient.seed(readPage);
    await readPage.addInitScript(() => {
      const flashes: string[] = [];
      Object.assign(window, { mentionLoadingFlashes: flashes });
      document.addEventListener("DOMContentLoaded", () => {
        new MutationObserver(() => {
          if (document.body.innerText.includes("Mention context unavailable"))
            flashes.push("access-loss");
        }).observe(document.body, { childList: true, subtree: true });
      });
    });
    await readPage.goto(`${origin}/chi?view=inbox`);
    await expect(readPage.getByText("Signed in as @mochi-the-kitty", { exact: true })).toBeVisible({
      timeout: 45000,
    });
    const compactPage = await compactSender.newPage();
    await sender.seed(compactPage);
    let localScopeRequests = 0;
    compactPage.on("websocket", (socket) =>
      socket.on("framesent", (frame) => {
        const text = String(frame.payload);
        if (text.includes(sender.localWorkspaceId) && text.includes('"action":"scope"'))
          localScopeRequests++;
      }),
    );
    await compactPage.goto(`${origin}/h/${sender.serverId}/agent/${sender.localAgentId}`);
    await expect(composerLocator(compactPage)).toBeVisible({ timeout: 60000 });
    await composerLocator(compactPage).fill("@local-file");
    await expect(
      compactPage
        .getByTestId("composer-autocomplete-popover")
        .getByText("local-file.txt", { exact: true }),
    ).toBeVisible();
    await composerLocator(compactPage).press("Escape");
    await plainChat(compactPage);
    await openActions(compactPage);
    await expect(
      compactPage.getByText(
        /Share to Chi|Capture to Chi|Continue on another host|Mention context unavailable/,
      ),
    ).toHaveCount(0);
    expect(localScopeRequests).toBe(0);
    await compactPage.screenshot({
      path: testInfo.outputPath("compact-local-workspace-menu.png"),
      fullPage: true,
    });
    await compactPage.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
    const compactInput = composerLocator(compactPage);
    await expect(compactInput).toBeVisible({ timeout: 60000 });
    await compactInput.fill("@mo");
    await expect(
      compactPage
        .getByTestId("composer-autocomplete-popover")
        .getByText("@mochi-the-kitty", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await compactInput.press("Tab");
    await expect(compactInput).toHaveValue("@mochi-the-kitty ");
    await plainChat(compactPage);
    await compactPage.screenshot({
      path: testInfo.outputPath("compact-plain-chat.png"),
      fullPage: true,
    });
    await compactPage.close();
    await sendPage.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
    await expect(composerLocator(sendPage)).toBeVisible({ timeout: 60000 });
    await plainChat(sendPage);
    // The mapped workspace resolves its destination automatically; there is no
    // Share step, only the header chip and the automatic capture after the turn.
    await expect(sendPage.getByTestId("workspace-header-destination")).toContainText("Henkaku");
    await openActions(sendPage);
    await expect(sendPage.getByRole("menuitem", { name: "Share to Chi", exact: true })).toHaveCount(
      0,
    );
    await expect(
      sendPage.getByRole("menuitem", { name: "Capture to Chi", exact: true }),
    ).toHaveCount(0);
    await expect(
      sendPage.getByRole("menuitem", { name: "Continue on another host", exact: true }),
    ).toBeVisible();
    await sendPage.keyboard.press("Escape");
    const input = composerLocator(sendPage),
      suggestions = sendPage.getByTestId("composer-autocomplete-popover");
    await input.fill("@mention-file");
    await expect(suggestions.getByText("mention-file.txt", { exact: true })).toBeVisible();
    await input.press("Tab");
    await expect(input).toHaveValue('"mention-file.txt"');
    await input.fill("@mo");
    await expect(suggestions.getByText("@mochi-the-kitty", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await input.press("Tab");
    await expect(input).toHaveValue("@mochi-the-kitty ");
    await openActions(sendPage);
    await expect(
      sendPage.getByText("Mention recipients: @mochi-the-kitty", { exact: true }),
    ).toBeVisible();
    await sendPage.getByRole("button", { name: "Clear recipients", exact: true }).click();
    await sendPage.keyboard.press("Escape");
    await input.fill("@mo");
    await expect(suggestions.getByText("@mochi-the-kitty", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await input.press("Tab");
    await expect(input).toHaveValue("@mochi-the-kitty ");
    await input.fill("/review @mochi-the-kitty");
    await sendPage.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      sendPage.getByText(
        "Send human mentions as plain text. Remove attachments and slash/skill commands before sending.",
        { exact: true },
      ),
    ).toBeVisible();
    const question = `@mochi-the-kitty Please inspect this synthetic persisted message. ${runId}`;
    await input.fill(question);
    await sender.loseNextCreateReply();
    await sendPage.getByRole("button", { name: "Send message", exact: true }).click();
    await openActions(sendPage);
    await expect(sendPage.getByRole("button", { name: "Retry mentions", exact: true })).toBeVisible(
      { timeout: 45000 },
    );
    await sendPage.screenshot({
      path: testInfo.outputPath("desktop-menu-mention-retry.png"),
      fullPage: true,
    });
    await sendPage.reload();
    await expect(composerLocator(sendPage)).toBeVisible({ timeout: 30000 });
    await openActions(sendPage);
    await expect(sendPage.getByRole("button", { name: "Retry mentions", exact: true })).toBeVisible(
      { timeout: 30000 },
    );
    await sendPage.getByRole("button", { name: "Retry mentions", exact: true }).click();
    await expect(
      sendPage.getByText("@mochi-the-kitty: Mention delivered", { exact: true }),
    ).toBeVisible({ timeout: 45000 });
    const attempts = await sender.attempts();
    expect(attempts.createAttempts).toHaveLength(2);
    expect(attempts.createAttempts[1]).toBe(attempts.createAttempts[0]);
    await sendPage.keyboard.press("Escape");
    await plainChat(sendPage);
    await sendPage.screenshot({
      path: testInfo.outputPath("desktop-plain-chat.png"),
      fullPage: true,
    });

    // No host or workspace coordinates: Chi's recipient identity owns the flat list.
    await readPage.goto(`${origin}/chi?view=inbox`);
    await expect(readPage.getByText("Signed in as @mochi-the-kitty", { exact: true })).toBeVisible({
      timeout: 45000,
    });
    await expect(readPage.getByRole("button", { name: "Choose host", exact: true })).toHaveCount(0);
    await expect(readPage.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(readPage.getByLabel("Unread mention", { exact: true })).toHaveCount(1);
    // History-style rail: no manual refresh, no Inbox/Project mode buttons.
    await expect(readPage.getByRole("button", { name: "Refresh", exact: true })).toHaveCount(0);
    await expect(readPage.getByRole("button", { name: "Inbox", exact: true })).toHaveCount(0);
    await expect(readPage.getByRole("button", { name: "Project", exact: true })).toHaveCount(0);
    await expect(readPage.getByTestId("inbox-search-input")).toBeVisible();
    await expect(readPage.getByTestId("inbox-repo-filter-trigger")).toBeVisible();
    const mentionSearch = readPage.getByTestId("inbox-search-input");
    await mentionSearch.fill("no-such-mention-run-xyz");
    await expect(readPage.getByText("No mentions match", { exact: true })).toBeVisible();
    await expect(
      readPage.getByRole("button", { name: `Open mention ${question}`, exact: true }),
    ).toHaveCount(0);
    await readPage.getByTestId("inbox-search-clear").click();
    await expect(
      readPage.getByRole("button", { name: `Open mention ${question}`, exact: true }),
    ).toBeVisible();
    await readPage.setViewportSize({ width: 1440, height: 1080 });
    await expect(readPage.getByLabel("1 unread mentions", { exact: true })).toBeVisible();
    await readPage.screenshot({
      path: testInfo.outputPath("desktop-flat-inbox-unread.png"),
      fullPage: true,
    });
    await readPage.setViewportSize({ width: 390, height: 844 });
    await readPage.getByRole("button", { name: `Open mention ${question}`, exact: true }).click();
    await expect(readPage.getByText(/Exact entry: msg_synthetic_/)).toBeVisible({ timeout: 30000 });
    await expect(readPage.getByText(/paseoClientMessageId/)).toBeVisible();
    await expect(
      readPage.getByRole("button", { name: "Continue here", exact: true }),
    ).toBeVisible();
    await expect(readPage.getByText("open · revision 2", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await readPage.getByRole("button", { name: "Browse pinned context", exact: true }).click();
    await expect(readPage.getByRole("button", { name: /^user: msg_synthetic_/ })).toBeVisible({
      timeout: 30000,
    });
    await readPage.getByRole("button", { name: /^user: msg_synthetic_/ }).click();
    await readPage.screenshot({
      path: testInfo.outputPath("compact-exact-source.png"),
      fullPage: true,
    });
    await readPage.getByRole("button", { name: "Acknowledge", exact: true }).click();
    await expect(readPage.getByText("acknowledged · revision 3", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await recipient.loseNextReplyReply();
    await readPage
      .getByRole("textbox", { name: "Reply to mention", exact: true })
      .fill("Checked the exact synthetic user entry; the context is preserved.");
    await readPage.getByRole("button", { name: "Send reply", exact: true }).click();
    await expect(
      readPage.getByRole("button", { name: "Retry saved operation", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await readPage.screenshot({
      path: testInfo.outputPath("compact-reply-retry.png"),
      fullPage: true,
    });
    await readPage.getByRole("button", { name: "Retry saved operation", exact: true }).click();
    await expect(readPage.getByText("acknowledged · revision 4", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    const replies = await recipient.attempts();
    expect(replies.replyAttempts).toHaveLength(2);
    expect(replies.replyAttempts[1]).toBe(replies.replyAttempts[0]);
    await readPage.reload();
    await expect(
      readPage.getByRole("button", { name: `Open mention ${question}`, exact: true }),
    ).toBeVisible({ timeout: 30000 });
    await expect(readPage.getByLabel("Unread mention", { exact: true })).toHaveCount(0);
    await readPage.getByRole("button", { name: `Open mention ${question}`, exact: true }).click();

    // The author has the source host connected: an exact native ID opens/highlights its turn.
    await sendPage.getByTestId("sidebar-mentions").click();
    await expect(sendPage.getByText("Signed in as @sava-the-owl", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await sendPage.getByRole("button", { name: `Open mention ${question}`, exact: true }).click();
    await expect(sendPage.locator('[data-testid^="referenced-entry-msg_synthetic_"]')).toBeVisible({
      timeout: 30000,
    });
    await plainChat(sendPage);
    await sendPage.screenshot({
      path: testInfo.outputPath("desktop-exact-entry-deep-link.png"),
      fullPage: true,
    });
    await sendPage.getByTestId("sidebar-mentions").click();
    await sendPage
      .getByRole("button", { name: `Discuss mention ${question}`, exact: true })
      .click();
    const authorReply = `Thanks Mochi; Sava confirms the pinned context. ${runId}`;
    await sendPage
      .getByRole("textbox", { name: "Reply to mention", exact: true })
      .fill(authorReply);
    await sendPage.getByRole("button", { name: "Send reply", exact: true }).click();
    await expect(sendPage.getByText("acknowledged · revision 5", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await readPage.bringToFront();
    // The open detail refreshes on the shared 30s mention interval while visible.
    // Wait two ticks so the exact boundary is never the test's race.
    await expect(readPage.getByText(authorReply, { exact: true })).toBeVisible({ timeout: 45000 });
    expect(await readPage.evaluate(() => Reflect.get(window, "mentionLoadingFlashes"))).toEqual([]);
    await sender.hideSources();
    await readPage.bringToFront();
    await expect(readPage.getByText("Mention context unavailable", { exact: true })).toBeVisible({
      timeout: 45000,
    });
    await expect(readPage.getByText(/paseoClientMessageId/)).toHaveCount(0);
    await expect(readPage.getByText(question, { exact: true })).toHaveCount(0);
    await readPage.screenshot({
      path: testInfo.outputPath("compact-access-revoked.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } catch (error) {
    console.log(
      "RECIPIENT PAGE",
      await readPage
        .locator("body")
        .innerText()
        .catch(() => "unavailable"),
    );
    throw error;
  } finally {
    await Promise.allSettled([
      desktop.close(),
      compact.close(),
      compactSender.close(),
      recipient.close(),
      sender.close(),
    ]);
  }
});

// ---------------------------------------------------------------------------
// P1 sync destinations — automatic capture and its failure/recovery surfaces.
// These run against the mapped synthetic repository (CHI_CONFIG above); no test
// clicks Share, because a mapped workspace associates and captures on its own.
// ---------------------------------------------------------------------------

async function expectNotice(page: Page) {
  await expect(page.getByTestId("chi-sync-notice")).toBeVisible({ timeout: 90000 });
}
async function sendPrompt(page: Page, text: string) {
  await composerLocator(page).fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
}
async function expectNoChiActions(page: Page) {
  await page.getByTestId("workspace-header-menu-trigger").click();
  await expect(page.getByTestId("workspace-header-menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Share to Chi", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Capture to Chi", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

test.describe("sync destinations (rendered)", () => {
  test("mapped vs local header on desktop and compact", async ({ browser }, testInfo) => {
    test.setTimeout(240000);
    const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
    const runId = randomUUID();
    const sender = await startMentionActor("sava-the-owl", origin, runId, { chi: CHI_CONFIG });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const compact = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const desktopPage = await desktop.newPage();
    const compactPage = await compact.newPage();
    desktopPage.setDefaultTimeout(30000);
    compactPage.setDefaultTimeout(30000);
    try {
      await sender.seed(desktopPage);
      await sender.seed(compactPage);
      await desktopPage.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
      await expect(desktopPage.getByTestId("workspace-header-destination")).toContainText(
        "Henkaku",
        { timeout: 60000 },
      );
      await compactPage.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
      await expect(compactPage.getByTestId("workspace-header-destination")).toContainText(
        "Henkaku",
        { timeout: 60000 },
      );
      await desktopPage.screenshot({
        path: testInfo.outputPath("sync-mapped-header-desktop.png"),
        fullPage: true,
      });
      await compactPage.screenshot({
        path: testInfo.outputPath("sync-mapped-header-compact.png"),
        fullPage: true,
      });

      // One tap shows the effective destination, audience, account and matched rule.
      await desktopPage.getByTestId("workspace-header-destination").click();
      await expect(desktopPage.getByTestId("sync-destination-audience")).toContainText(
        "Shared with repository readers",
      );
      await expect(desktopPage.getByTestId("sync-destination-endpoint")).toContainText(
        "chi-backend",
      );
      await expect(desktopPage.getByTestId("sync-destination-account")).toBeVisible();
      await expect(desktopPage.getByTestId("sync-destination-rule")).toContainText(
        "github:gszep/chi-synthetic-two-actor-20260925",
      );
      await desktopPage.keyboard.press("Escape");
      await compactPage.getByTestId("workspace-header-destination").click();
      await expect(compactPage.getByTestId("sync-destination-audience")).toContainText(
        "Shared with repository readers",
      );
      await compactPage.keyboard.press("Escape");

      // An unmapped, non-Git workspace stays local and exposes no Chi actions.
      await desktopPage.goto(`${origin}/h/${sender.serverId}/agent/${sender.localAgentId}`);
      await expect(desktopPage.getByTestId("workspace-header-destination")).toContainText("local", {
        timeout: 60000,
      });
      await expectNoChiActions(desktopPage);
      await compactPage.goto(`${origin}/h/${sender.serverId}/agent/${sender.localAgentId}`);
      await expect(compactPage.getByTestId("workspace-header-destination")).toContainText("local", {
        timeout: 60000,
      });
      await compactPage.screenshot({
        path: testInfo.outputPath("sync-local-header-compact.png"),
        fullPage: true,
      });
    } finally {
      await Promise.allSettled([desktop.close(), compact.close(), sender.close()]);
    }
  });

  test("a settled turn uploads with no Share action and the recipient sees the mention", async ({
    browser,
  }) => {
    test.setTimeout(240000);
    const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
    const runId = randomUUID();
    const sender = await startMentionActor("sava-the-owl", origin, runId, { chi: CHI_CONFIG });
    const recipient = await startMentionActor("mochi-the-kitty", origin, runId, {
      chi: CHI_CONFIG,
    });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const compact = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const sendPage = await desktop.newPage();
    const readPage = await compact.newPage();
    sendPage.setDefaultTimeout(30000);
    readPage.setDefaultTimeout(30000);
    try {
      await sender.seed(sendPage);
      await sendPage.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
      await expect(composerLocator(sendPage)).toBeVisible({ timeout: 60000 });
      await plainChat(sendPage);
      await expectNoChiActions(sendPage);
      await expect(sendPage.getByTestId("workspace-header-destination")).toContainText("Henkaku");

      const question = `@mochi-the-kitty Auto-captured source ${runId}`;
      await sendPrompt(sendPage, question);
      await openActions(sendPage);
      await expect(
        sendPage.getByText("@mochi-the-kitty: Mention delivered", { exact: true }),
      ).toBeVisible({ timeout: 120000 });
      await sendPage.keyboard.press("Escape");
      await plainChat(sendPage);
      await expect(sendPage.getByTestId("workspace-header-destination")).toContainText("Henkaku");

      // The recipient's History-style inbox shows a mention made only by capture.
      await recipient.seed(readPage);
      await readPage.goto(`${origin}/chi?view=inbox`);
      await expect(
        readPage.getByText("Signed in as @mochi-the-kitty", { exact: true }),
      ).toBeVisible({
        timeout: 45000,
      });
      await expect(
        readPage.getByRole("button", { name: `Open mention ${question}`, exact: true }),
      ).toBeVisible({ timeout: 30000 });
      await readPage.getByRole("button", { name: `Open mention ${question}`, exact: true }).click();
      await expect(readPage.getByText(/Exact entry: msg_synthetic_/)).toBeVisible({
        timeout: 30000,
      });
      await readPage.getByRole("button", { name: "Acknowledge", exact: true }).click();
      await expect(readPage.getByText("acknowledged · revision 3", { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await readPage
        .getByRole("textbox", { name: "Reply to mention", exact: true })
        .fill("Auto-captured context confirmed.");
      await readPage.getByRole("button", { name: "Send reply", exact: true }).click();
      await expect(readPage.getByText("acknowledged · revision 4", { exact: true })).toBeVisible({
        timeout: 30000,
      });
    } finally {
      await Promise.allSettled([
        desktop.close(),
        compact.close(),
        recipient.close(),
        sender.close(),
      ]);
    }
  });

  test("failed capture shows one notice while prompts keep working", async ({ browser }) => {
    test.setTimeout(240000);
    const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
    const runId = randomUUID();
    const sender = await startMentionActor("sava-the-owl", origin, runId, { chi: CHI_CONFIG });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    try {
      await sender.failEvidence();
      await sender.seed(page);
      await page.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
      await expect(composerLocator(page)).toBeVisible({ timeout: 60000 });
      await sendPrompt(page, `offline capture ${runId}`);
      await expectNotice(page);
      await expect(page.getByTestId("chi-sync-notice")).toContainText(
        "For others to see this session and for its mentions to appear, sync needs to succeed.",
      );
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();

      // A further prompt in the same session still starts and settles normally.
      const secondPrompt = `second prompt while offline ${runId}`;
      await sendPrompt(page, secondPrompt);
      await expect(
        page.getByTestId("conversation-chat-feed").getByText(secondPrompt, { exact: false }),
      ).toBeVisible({ timeout: 60000 });
      await expect(page.getByTestId("chi-sync-notice")).toHaveCount(1);
      await plainChat(page);
      await sender.allowEvidence();
    } finally {
      await Promise.allSettled([context.close(), sender.close()]);
    }
  });

  test("dismiss keeps pending, offline retry dedupes, success clears", async ({ browser }) => {
    test.setTimeout(240000);
    const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
    const runId = randomUUID();
    const sender = await startMentionActor("sava-the-owl", origin, runId, { chi: CHI_CONFIG });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    try {
      await sender.failEvidence();
      await sender.seed(page);
      await page.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
      await expect(composerLocator(page)).toBeVisible({ timeout: 60000 });
      await sendPrompt(page, `dismiss retry ${runId}`);
      await expectNotice(page);

      // Retry while still offline keeps exactly one notice.
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(page.getByTestId("chi-sync-notice")).toHaveCount(1);

      // Dismiss hides the notice but not the pending state.
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      await expect(page.getByTestId("chi-sync-notice")).toHaveCount(0);
      await page.reload();
      await expect(composerLocator(page)).toBeVisible({ timeout: 60000 });
      await expectNotice(page);

      // Success clears the notice.
      await sender.allowEvidence();
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(page.getByTestId("chi-sync-notice")).toHaveCount(0, { timeout: 90000 });
    } finally {
      await Promise.allSettled([context.close(), sender.close()]);
    }
  });

  test("restart recovery uploads a pending capture with no new turn", async ({ browser }) => {
    test.setTimeout(240000);
    const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
    const runId = randomUUID();
    const sender = await startMentionActor("sava-the-owl", origin, runId, { chi: CHI_CONFIG });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    try {
      await sender.failEvidence();
      await sender.seed(page);
      await page.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
      await expect(composerLocator(page)).toBeVisible({ timeout: 60000 });
      await sendPrompt(page, `restart recovery ${runId}`);
      await expectNotice(page);

      // Persist capture-needed state, then bring the backend back and restart.
      await sender.allowEvidence();
      await sender.restart();
      await sender.seed(page);
      await page.reload();
      await expect(composerLocator(page)).toBeVisible({ timeout: 60000 });
      await expect(page.getByTestId("chi-sync-notice")).toHaveCount(0, { timeout: 120000 });
      await expect(page.getByTestId("workspace-header-destination")).toContainText("Henkaku");
    } finally {
      await Promise.allSettled([context.close(), sender.close()]);
    }
  });

  test("recipient opens, acknowledges and replies to an auto-captured mention", async ({
    browser,
  }) => {
    test.setTimeout(240000);
    const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
    const runId = randomUUID();
    const sender = await startMentionActor("sava-the-owl", origin, runId, { chi: CHI_CONFIG });
    const recipient = await startMentionActor("mochi-the-kitty", origin, runId, {
      chi: CHI_CONFIG,
    });
    const sendContext = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const readContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const sendPage = await sendContext.newPage();
    const readPage = await readContext.newPage();
    sendPage.setDefaultTimeout(30000);
    readPage.setDefaultTimeout(30000);
    try {
      await sender.seed(sendPage);
      await sendPage.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
      await expect(composerLocator(sendPage)).toBeVisible({ timeout: 60000 });
      const question = `@mochi-the-kitty Auto-capture deep link ${runId}`;
      await sendPrompt(sendPage, question);
      await openActions(sendPage);
      await expect(
        sendPage.getByText("@mochi-the-kitty: Mention delivered", { exact: true }),
      ).toBeVisible({ timeout: 120000 });
      await sendPage.keyboard.press("Escape");

      await recipient.seed(readPage);
      await readPage.goto(`${origin}/chi?view=inbox`);
      await expect(
        readPage.getByText("Signed in as @mochi-the-kitty", { exact: true }),
      ).toBeVisible({
        timeout: 45000,
      });
      await expect(readPage.getByLabel("Unread mention", { exact: true })).toHaveCount(1);
      await readPage.getByRole("button", { name: `Open mention ${question}`, exact: true }).click();
      await expect(readPage.getByText(/Exact entry: msg_synthetic_/)).toBeVisible({
        timeout: 30000,
      });
      await expect(readPage.getByText("open · revision 2", { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await readPage.getByRole("button", { name: "Browse pinned context", exact: true }).click();
      await expect(readPage.getByRole("button", { name: /^user: msg_synthetic_/ })).toBeVisible({
        timeout: 30000,
      });
      await readPage.getByRole("button", { name: "Acknowledge", exact: true }).click();
      await expect(readPage.getByText("acknowledged · revision 3", { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await readPage
        .getByRole("textbox", { name: "Reply to mention", exact: true })
        .fill("Auto-captured reply.");
      await readPage.getByRole("button", { name: "Send reply", exact: true }).click();
      await expect(readPage.getByText("acknowledged · revision 4", { exact: true })).toBeVisible({
        timeout: 30000,
      });
      await expect(readPage.getByLabel("Unread mention", { exact: true })).toHaveCount(0);
    } finally {
      await Promise.allSettled([
        sendContext.close(),
        readContext.close(),
        recipient.close(),
        sender.close(),
      ]);
    }
  });

  test("a legacy association still uploads with no chi config", async ({ browser }) => {
    test.setTimeout(240000);
    const origin = `http://localhost:${process.env.E2E_METRO_PORT}`;
    const runId = randomUUID();
    // No chi config: the legacy single-deployment behaviour must be preserved,
    // including the pinned audience of a pre-existing association.
    const sender = await startMentionActor("sava-the-owl", origin, runId);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    try {
      await sender.seedLegacyAssociation();
      await sender.seed(page);
      await page.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
      await expect(composerLocator(page)).toBeVisible({ timeout: 60000 });
      // No mapping means no configured destination, but the legacy label still
      // uploads to the default deployment. The chip must report that, not local.
      await expect(page.getByTestId("workspace-header-destination")).toContainText("Chi", {
        timeout: 60000,
      });
      await page.getByTestId("workspace-header-destination").click();
      await expect(page.getByTestId("sync-destination-audience")).toContainText(
        "Shared with repository readers",
      );
      await page.keyboard.press("Escape");
      // Continue and mention delivery stay available on the default deployment.
      await openActions(page);
      await expect(
        page.getByRole("menuitem", { name: "Continue on another host", exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Mentions are not available for this destination.")).toHaveCount(
        0,
      );
      await page.keyboard.press("Escape");

      const before = (await sender.sources()).length;
      const countSources = async () => (await sender.sources()).length;
      await sendPrompt(page, `legacy shared capture ${runId}`);
      await expect.poll(countSources, { timeout: 120000 }).toBeGreaterThan(before);
      const uploaded = await sender.sources();
      const newest = uploaded.at(-1);
      expect(newest).toBeTruthy();
      expect(await sender.sourceVisibility(newest!)).toBe("shared");
      await plainChat(page);
      await expect(page.getByTestId("chi-sync-notice")).toHaveCount(0);
    } finally {
      await Promise.allSettled([context.close(), sender.close()]);
    }
  });
});
