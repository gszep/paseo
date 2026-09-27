import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startMentionActor } from "../support/helpers/chi-mentions";
import { composerLocator } from "../support/helpers/composer";

test("two authenticated humans send, retry, read exact source, acknowledge and reply on desktop and compact web", async ({
  browser,
}, testInfo) => {
  test.setTimeout(240000);
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
  const errors: string[] = [];
  sendPage.on("pageerror", (error) => errors.push(error.message));
  readPage.on("pageerror", (error) => errors.push(error.message));
  try {
    await sender.seed(sendPage);
    await recipient.seed(readPage);
    await sendPage.goto(`${origin}/h/${sender.serverId}/agent/${sender.agentId}`);
    await expect(composerLocator(sendPage)).toBeVisible({ timeout: 60000 });
    await sendPage.getByRole("button", { name: "Share to Chi", exact: true }).click();
    await expect(sendPage.getByText("Future settled turns are captured to Chi.")).toBeVisible({
      timeout: 30000,
    });
    await expect(sendPage.getByRole("button", { name: "Open evidence", exact: true })).toBeVisible({
      timeout: 30000,
    });
    const input = composerLocator(sendPage);
    await input.fill("@mention-file");
    await expect(sendPage.getByText("mention-file.txt", { exact: true })).toBeVisible();
    await input.fill("@mochi");
    await expect(sendPage.getByText("@mochi-the-kitty", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await sendPage.getByText("@mochi-the-kitty", { exact: true }).click();
    await input.fill("/review @mochi-the-kitty");
    await sendPage.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      sendPage.getByText(
        "Send human mentions as plain text. Remove attachments and slash/skill commands before sending.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(input).toHaveValue("/review @mochi-the-kitty");
    const question = `@mochi-the-kitty Please inspect this synthetic persisted message. ${runId}`;
    await input.fill(question);
    await sender.loseNextCreateReply();
    await sendPage.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(sendPage.getByRole("button", { name: "Retry mentions", exact: true })).toBeVisible(
      { timeout: 45000 },
    );
    await sendPage.screenshot({
      path: testInfo.outputPath("desktop-mention-retry.png"),
      fullPage: true,
    });
    await sendPage.reload();
    await expect(sendPage.getByRole("button", { name: "Retry mentions", exact: true })).toBeVisible(
      { timeout: 30000 },
    );
    await sendPage.getByRole("button", { name: "Retry mentions", exact: true }).click();
    await expect(
      sendPage.getByText("@mochi-the-kitty: Mention delivered", { exact: true }),
    ).toBeVisible({ timeout: 45000 });
    const { createAttempts } = await sender.attempts();
    expect(createAttempts).toHaveLength(2);
    expect(createAttempts[1]).toBe(createAttempts[0]);
    await sendPage.screenshot({
      path: testInfo.outputPath("desktop-mention-delivered.png"),
      fullPage: true,
    });

    await readPage.goto(
      `${origin}/chi?view=inbox&host=${recipient.serverId}&workspace=${recipient.workspaceId}`,
    );
    await expect(readPage.getByText("Signed in as @mochi-the-kitty", { exact: true })).toBeVisible({
      timeout: 45000,
    });
    await readPage.getByRole("button", { name: `Open mention ${question}`, exact: true }).click();
    await expect(readPage.getByText(question, { exact: true })).toBeVisible();
    await readPage.getByRole("button", { name: "Read exact source 1", exact: true }).click();
    await expect(readPage.getByText(/Exact entry: msg_synthetic_/)).toBeVisible({ timeout: 30000 });
    await expect(readPage.getByText(/paseoClientMessageId/)).toBeVisible();
    await readPage.getByRole("button", { name: "Browse pinned context", exact: true }).click();
    await expect(readPage.getByRole("button", { name: /^user: msg_synthetic_/ })).toBeVisible({
      timeout: 30000,
    });
    await readPage.getByRole("button", { name: /^user: msg_synthetic_/ }).click();
    await expect(readPage.getByText(/paseoClientMessageId/)).toBeVisible();
    await readPage.screenshot({
      path: testInfo.outputPath("compact-exact-source.png"),
      fullPage: true,
    });
    await readPage.getByRole("button", { name: "Acknowledge", exact: true }).click();
    await expect(readPage.getByText("acknowledged · revision 2", { exact: true })).toBeVisible({
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
    await expect(readPage.getByText("acknowledged · revision 3", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    const { replyAttempts } = await recipient.attempts();
    expect(replyAttempts).toHaveLength(2);
    expect(replyAttempts[1]).toBe(replyAttempts[0]);
    await readPage.screenshot({
      path: testInfo.outputPath("compact-reply-delivered.png"),
      fullPage: true,
    });

    await sendPage.getByRole("button", { name: "Open mentions", exact: true }).click();
    await expect(sendPage.getByText("Signed in as @sava-the-owl", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await sendPage.getByRole("button", { name: "Project", exact: true }).click();
    await sendPage.getByRole("button", { name: `Open mention ${question}`, exact: true }).click();
    await expect(
      sendPage.getByText("Checked the exact synthetic user entry; the context is preserved.", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 30000 });
    const authorReply = `Thanks Mochi; Sava confirms the pinned context. ${runId}`;
    await sendPage
      .getByRole("textbox", { name: "Reply to mention", exact: true })
      .fill(authorReply);
    await sendPage.getByRole("button", { name: "Send reply", exact: true }).click();
    await expect(sendPage.getByText("acknowledged · revision 4", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await readPage.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(readPage.getByText(authorReply, { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(readPage.getByText("acknowledged · revision 4", { exact: true })).toBeVisible();
    await sendPage.screenshot({
      path: testInfo.outputPath("desktop-sender-response.png"),
      fullPage: true,
    });
    await sender.hideSources();
    await readPage.getByRole("button", { name: "Refresh", exact: true }).click();
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
  } finally {
    await desktop.close();
    await compact.close();
    await recipient.close();
    await sender.close();
  }
});
