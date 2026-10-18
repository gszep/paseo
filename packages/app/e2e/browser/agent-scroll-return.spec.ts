import { expect, type CDPSession, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { test } from "../support/fixtures";
import {
  readScrollMetrics,
  scrollChatAwayFromBottom,
} from "../support/helpers/agent-bottom-anchor";
import { getServerId } from "../support/helpers/server-id";
import { seedMockAgentWorkspace, type MockAgentWorkspace } from "../support/helpers/mock-agent";
import {
  continueToNextQuestion,
  fillQuestionAnswer,
  submitQuestionAnswers,
  waitForQuestionPrompt,
} from "../support/helpers/questions";
import { openMobileAgentSidebar } from "../support/helpers/sidebar";
import {
  expectTimelinePromptVisible,
  openAgentTimeline,
  seedLongMockAgentTimeline,
} from "../support/helpers/timeline-pagination";
import { switchWorkspaceViaSidebar } from "../support/helpers/workspace-ui";

async function expectChatAtBottom(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readScrollMetrics(page)).distanceFromBottom, {
      timeout: 10_000,
    })
    .toBeLessThanOrEqual(72);
}

async function openCompactWorkspace(
  page: Page,
  workspace: Pick<MockAgentWorkspace, "workspaceId">,
): Promise<void> {
  await openMobileAgentSidebar(page);
  await switchWorkspaceViaSidebar({
    page,
    serverId: getServerId(),
    workspaceId: workspace.workspaceId,
  });
}

function armDelayedScrollForHiddenChat(page: Page): Promise<void> {
  return page
    .locator('[data-testid="agent-chat-scroll"]:visible')
    .first()
    .evaluate((root) => {
      const scroll = root as HTMLElement;
      return new Promise<void>((resolve) => {
        const observer = new ResizeObserver(() => {
          if (scroll.getClientRects().length > 0) return;
          observer.disconnect();
          scroll.dispatchEvent(new Event("scroll"));
          resolve();
        });
        observer.observe(scroll);
      });
    });
}

test("pointer jitter cannot turn geometry changes into scroll intent", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const backgroundPrompt = "Continue after a pointer is released outside the chat";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    const scroll = page.locator('[data-testid="agent-chat-scroll"]:visible').first();
    const bounds = await scroll.boundingBox();
    expect(bounds, "Expected visible chat scroll bounds").not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2 - 3);
    await page.setViewportSize({ width: 390, height: 1124 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.mouse.move(410, bounds!.y + bounds!.height / 2 - 3);
    await page.mouse.up();

    await longChat.client.sendAgentMessage(longChat.agentId, backgroundPrompt);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);
    await expectTimelinePromptVisible(page, backgroundPrompt);
    await expectChatAtBottom(page);
  } finally {
    await longChat.cleanup();
  }
});

test("a retained chat ignores delayed scroll delivery while hidden", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-hidden-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });
  const backgroundPrompt = "emit 500 coalesced agent stream updates";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    const delayedScrollDelivered = armDelayedScrollForHiddenChat(page);
    await openCompactWorkspace(page, otherWorkspace);
    await delayedScrollDelivered;
    await longChat.client.sendAgentMessage(longChat.agentId, backgroundPrompt);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);

    await openCompactWorkspace(page, longChat);
    await expectTimelinePromptVisible(page, backgroundPrompt);
    await expectChatAtBottom(page);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("a retained streaming chat returns to the bottom and continues following", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-streaming-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });
  const streamingPrompt = "Continue streaming while this workspace is hidden";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    await longChat.client.sendAgentMessage(longChat.agentId, streamingPrompt);
    await longChat.client.waitForAgentUpsert(
      longChat.agentId,
      (snapshot) => snapshot.status === "running",
      15_000,
    );
    await openCompactWorkspace(page, otherWorkspace);
    await openCompactWorkspace(page, longChat);

    await expectTimelinePromptVisible(page, streamingPrompt);
    await expectChatAtBottom(page);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);
    await expectChatAtBottom(page);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("a retained chat preserves an intentional reading position", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const otherWorkspace = await seedMockAgentWorkspace({
    repoPrefix: "scroll-return-reading-position-other-",
    title: "Other workspace",
    initialPrompt: "Open the other workspace",
  });

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    const readingPosition = await scrollChatAwayFromBottom(page, {
      deltaY: -900,
      minDistanceFromBottom: 300,
    });

    await openCompactWorkspace(page, otherWorkspace);
    await openCompactWorkspace(page, longChat);

    await expect
      .poll(async () => Math.abs((await readScrollMetrics(page)).offsetY - readingPosition.offsetY))
      .toBeLessThanOrEqual(24);
  } finally {
    await Promise.allSettled([longChat.cleanup(), otherWorkspace.cleanup()]);
  }
});

test("editing keys in an embedded question keep output following", async ({ page }) => {
  test.setTimeout(240_000);
  const longChat = await seedLongMockAgentTimeline({ turns: 30 });
  const questionPrompt = "Emit synthetic questions: two free-write questions.";
  const firstQuestion = "What is the GitHub private repo URL to push to?";
  const secondQuestion = "What should the first commit message be?";

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentTimeline(page, longChat);
    await expectTimelinePromptVisible(page, longChat.newestPrompt);
    await expectChatAtBottom(page);

    await longChat.client.sendAgentMessage(longChat.agentId, questionPrompt);
    await waitForQuestionPrompt(page, 30_000);
    await fillQuestionAnswer(page, {
      question: firstQuestion,
      answer: "git@github.com:user/private-repo.git",
    });
    const firstInput = page
      .getByTestId("question-form-card")
      .first()
      .getByRole("textbox", { name: firstQuestion });
    const inputBounds = await firstInput.boundingBox();
    expect(inputBounds, "Expected embedded question input bounds").not.toBeNull();
    await page.mouse.move(
      inputBounds!.x + inputBounds!.width / 2,
      inputBounds!.y + inputBounds!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      inputBounds!.x + inputBounds!.width / 2 + 20,
      inputBounds!.y + inputBounds!.height / 2 - 3,
    );
    await page.mouse.up();
    await firstInput.press("Home");
    await firstInput.press("ArrowUp");
    await continueToNextQuestion(page);
    await fillQuestionAnswer(page, {
      question: secondQuestion,
      answer: "Initialize private repo",
    });
    await submitQuestionAnswers(page);
    await longChat.client.waitForFinish(longChat.agentId, 20_000);

    await expectChatAtBottom(page);
  } finally {
    await longChat.cleanup();
  }
});

for (const width of [1280, 390]) {
  for (const position of [
    "reading",
    "bottom",
    "background",
    "browser-background",
    "browser-background-reading",
    "reconnect",
  ] as const) {
    test(`question visibility ${position} at ${width}px`, async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const chat = await seedLongMockAgentTimeline({ turns: 12 });
      const other =
        position === "background"
          ? await seedMockAgentWorkspace({
              repoPrefix: "question-visibility-other-",
              title: "Other fixture",
            })
          : null;
      let lifecycle: CDPSession | undefined;
      try {
        await page.setViewportSize({ width, height: 900 });
        await openAgentTimeline(page, chat);
        await expectChatAtBottom(page);
        let readingTop: number | undefined;
        let readingAnchor: { id: string | null; top: number } | null = null;
        if (position === "reading" || position === "browser-background-reading") {
          readingTop = (
            await scrollChatAwayFromBottom(page, { deltaY: -600, minDistanceFromBottom: 300 })
          ).offsetY;
          readingAnchor = await page
            .locator('[data-testid="agent-chat-scroll"]:visible')
            .first()
            .evaluate((root) => {
              const viewport = root.getBoundingClientRect();
              const row = Array.from(
                root.querySelectorAll<HTMLElement>("[data-history-row-id]"),
              ).find(
                (e) =>
                  e.getBoundingClientRect().bottom > viewport.top + 4 &&
                  e.getBoundingClientRect().top < viewport.bottom,
              );
              return row
                ? {
                    id: row.getAttribute("data-history-row-id"),
                    top: row.getBoundingClientRect().top - viewport.top,
                  }
                : null;
            });
          await page.screenshot({ path: testInfo.outputPath("reading-before-question.png") });
        }
        if (other) {
          if (width === 390) await openMobileAgentSidebar(page);
          await switchWorkspaceViaSidebar({
            page,
            serverId: getServerId(),
            workspaceId: other.workspaceId,
          });
        }
        if (position === "browser-background" || position === "browser-background-reading") {
          lifecycle = await page.context().newCDPSession(page);
          await lifecycle.send("Page.setWebLifecycleState", { state: "frozen" });
        }
        // This is the isolated mock provider/daemon, never a live user question.
        await chat.client.sendAgentMessage(
          chat.agentId,
          "Emit synthetic questions: two free-write questions.",
        );
        await chat.client.waitForAgentUpsert(
          chat.agentId,
          (agent) => agent.pendingPermissions.some((p) => p.kind === "question"),
          15_000,
        );
        if (lifecycle) {
          await lifecycle.send("Page.setWebLifecycleState", { state: "active" });
          await lifecycle.detach();
          lifecycle = undefined;
          await page.bringToFront();
        }
        if (other) {
          if (width === 390) await openMobileAgentSidebar(page);
          await switchWorkspaceViaSidebar({
            page,
            serverId: getServerId(),
            workspaceId: chat.workspaceId,
          });
        }
        if (position === "reconnect") await page.reload();
        const card = page.getByTestId("question-form-card").first();
        await expect(card).toBeVisible({ timeout: 30_000 });
        await page.screenshot({ path: testInfo.outputPath("pending-before-action.png") });
        const afterMetrics = await readScrollMetrics(page);
        const afterAnchor = await page
          .locator('[data-testid="agent-chat-scroll"]:visible')
          .first()
          .evaluate((root, id) => {
            const row = Array.from(
              root.querySelectorAll<HTMLElement>("[data-history-row-id]"),
            ).find((e) => e.getAttribute("data-history-row-id") === id);
            return row ? row.getBoundingClientRect().top - root.getBoundingClientRect().top : null;
          }, readingAnchor?.id ?? null);
        await testInfo.attach("question-geometry", {
          body: JSON.stringify({ readingTop, readingAnchor, afterMetrics, afterAnchor }),
          contentType: "application/json",
        });
        await writeFile(
          testInfo.outputPath("question-geometry.json"),
          JSON.stringify({ readingTop, readingAnchor, afterMetrics, afterAnchor }),
        );
        if (readingTop !== undefined) {
          if (!readingAnchor?.id) throw new Error("Reading anchor was not captured");
          const anchor = readingAnchor;
          // Older-page prepends may change scrollTop. Preserve the actual read
          // row at the same viewport offset, not the document's absolute offset.
          await expect
            .poll(async () =>
              page
                .locator('[data-testid="agent-chat-scroll"]:visible')
                .first()
                .evaluate((root, before) => {
                  const row = root.querySelector<HTMLElement>(
                    `[data-history-row-id="${CSS.escape(before.id ?? "")}"]`,
                  );
                  return row
                    ? Math.abs(
                        row.getBoundingClientRect().top -
                          root.getBoundingClientRect().top -
                          before.top,
                      )
                    : Infinity;
                }, anchor),
            )
            .toBeLessThanOrEqual(24);
          const jump = page.getByTestId("scroll-to-question-button");
          await expect(jump).toBeInViewport();
          await jump.click();
        }
        await expect(card.getByTestId("question-form-current-question")).toBeInViewport();
        await expect(card.getByTestId("question-form-primary-action")).toBeInViewport();
        await page.screenshot({
          path: `test-results/question-visibility-${position}-${width}.png`,
        });
        await fillQuestionAnswer(page, {
          question: "What is the GitHub private repo URL to push to?",
          answer: "https://example.test/fixture",
        });
        await continueToNextQuestion(page);
        await fillQuestionAnswer(page, {
          question: "What should the first commit message be?",
          answer: "Synthetic visibility check",
        });
        await submitQuestionAnswers(page);
        await expect(page.getByTestId("scroll-to-question-button")).toHaveCount(0);
        await chat.client.waitForFinish(chat.agentId, 20_000);
        await chat.client.sendAgentMessage(chat.agentId, "emit 2 coalesced agent stream updates");
        await chat.client.waitForFinish(chat.agentId, 20_000);
        await expectChatAtBottom(page);
      } finally {
        if (lifecycle) {
          await lifecycle
            .send("Page.setWebLifecycleState", { state: "active" })
            .catch(() => undefined);
          await lifecycle.detach().catch(() => undefined);
        }
        await Promise.allSettled([chat.cleanup(), other?.cleanup()]);
      }
    });
  }
}
