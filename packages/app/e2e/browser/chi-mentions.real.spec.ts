import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startMentionActor } from "../support/helpers/chi-mentions";
import { composerLocator } from "../support/helpers/composer";

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
  const sender = await startMentionActor("sava-the-owl", origin, runId);
  const recipient = await startMentionActor("mochi-the-kitty", origin, runId);
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
    await openActions(sendPage);
    await sendPage.getByRole("menuitem", { name: "Share to Chi", exact: true }).click();
    await expect(
      sendPage.getByRole("menuitem", { name: "Capture to Chi", exact: true }),
    ).toBeVisible({ timeout: 30000 });
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
    await expect(readPage.getByText(authorReply, { exact: true })).toBeVisible({ timeout: 30000 });
    expect(await readPage.evaluate(() => Reflect.get(window, "mentionLoadingFlashes"))).toEqual([]);
    await sender.hideSources();
    await readPage.bringToFront();
    await expect(readPage.getByText("Mention context unavailable", { exact: true })).toBeVisible({
      timeout: 30000,
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
