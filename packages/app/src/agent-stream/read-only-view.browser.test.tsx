import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { StreamItem } from "@/types/stream";
import { ReadOnlyStreamView, type ReadOnlyStreamViewProps } from "./read-only-view";
import { PROMPT_JUMP_TOP_INSET_PX } from "./prompt-jump-settle";

let root: Root | undefined;
let container: HTMLDivElement;
const timestamp = new Date("2026-10-10T12:00:00Z");
const noOlder = {
  hasOlder: false,
  isLoadingOlder: false,
  progressKey: "pin",
  onLoadOlder: () => false,
};

function user(id: string): StreamItem {
  return { kind: "user_message", id, text: `User prompt ${id}`, timestamp };
}
function assistant(id: string, text = `Assistant response ${id}`): StreamItem {
  return { kind: "assistant_message", id, text, timestamp };
}
function mount(
  props: Partial<ReadOnlyStreamViewProps> & Pick<ReadOnlyStreamViewProps, "streamItems">,
) {
  if (!root) {
    container = document.createElement("div");
    container.style.cssText =
      "display:flex; width:100%; max-width:900px; height:360px; position:relative";
    document.body.append(container);
    root = createRoot(container);
  }
  // Deliberately no query client, host, workspace, toast, composer, or file resolver
  // providers. Agent/file/rewind hooks would fail rather than hiding behind fakes.
  act(() =>
    root!.render(
      <ReadOnlyStreamView historyId="pinned-history" historyPagination={noOlder} {...props} />,
    ),
  );
}
function scrollContainer() {
  const element = container.querySelector<HTMLElement>('[data-testid="agent-chat-scroll"]');
  if (!element) throw new Error("The normal stream viewport did not mount");
  return element;
}
function targetOffset() {
  const target = container.querySelector<HTMLElement>('[data-testid="referenced-history-item"]');
  if (!target) throw new Error("Target is not mounted");
  return target.getBoundingClientRect().top - scrollContainer().getBoundingClientRect().top;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});

test("reveals a loaded target before the normal viewport scrolls and keeps its stable identity on prepend", async () => {
  const items = Array.from({ length: 60 }, (_, index) => user(`row-${index}`));
  mount({ streamItems: items, targetItemId: "row-5" });
  await expect
    .poll(() => container.querySelector('[data-testid="referenced-history-item"]')?.textContent)
    .toContain("User prompt row-5");
  await expect.poll(() => Math.abs(targetOffset() - PROMPT_JUMP_TOP_INSET_PX)).toBeLessThan(3);
  const target = container.querySelector('[data-testid="referenced-history-item"]');
  expect(target?.querySelector('[aria-label="User"]')?.textContent).toContain("User prompt row-5");
  expect(target?.querySelector('[data-testid="user-message-author"]')?.textContent).toBe("User");
  expect(getComputedStyle(target as Element).backgroundColor).toBe("rgb(244, 244, 245)");

  act(() => {
    scrollContainer().scrollTop = 0;
    scrollContainer().dispatchEvent(new Event("scroll"));
  });
  const readingTop = targetOffset();
  act(() => scrollContainer().dispatchEvent(new WheelEvent("wheel", { deltaY: -20 })));
  await expect
    .poll(() => container.querySelector('[data-history-row-id="row-0"]')?.textContent)
    .toContain("User prompt row-0");
  await expect.poll(() => Math.abs(targetOffset() - readingTop)).toBeLessThan(3);

  mount({ streamItems: [user("older-0"), user("older-1"), ...items], targetItemId: "row-5" });
  await expect.poll(() => Math.abs(targetOffset() - readingTop)).toBeLessThan(3);
  expect(container.querySelector('[data-testid="referenced-history-item"]')).toBe(target);
  expect(container.querySelectorAll('[data-testid="referenced-history-item"]').length).toBe(1);

  mount({ streamItems: items, targetItemId: "row-40" });
  await expect
    .poll(() => container.querySelector('[data-testid="referenced-history-item"]')?.textContent)
    .toContain("User prompt row-40");
  await expect.poll(() => Math.abs(targetOffset() - PROMPT_JUMP_TOP_INSET_PX)).toBeLessThan(3);
});

test("reuses Markdown, tool, reasoning, and compaction rows without resource or agent actions", async () => {
  const items: StreamItem[] = [
    {
      ...user("prompt"),
      images: [
        {
          id: "private",
          mimeType: "image/png",
          storageType: "desktop-file",
          storageKey: "/recipient/secret.png",
          createdAt: 0,
        },
      ],
    } as StreamItem,
    assistant(
      "answer",
      "# Shared answer\n\n**bold evidence** and [file](file:///recipient/secret.txt) `src/private.ts`\n\n![remote beacon](https://example.invalid/private.png)",
    ),
    { kind: "thought", id: "thought", text: "Reasoning evidence", status: "ready", timestamp },
    {
      kind: "tool_call",
      id: "tool",
      timestamp,
      payload: {
        source: "agent",
        data: {
          name: "read_file",
          callId: "tool",
          provider: "opencode",
          error: null,
          status: "completed",
          detail: {
            type: "unknown",
            input: { path: "/recipient/private.txt" },
            output: "Stored tool result",
          },
        },
      },
    },
    { kind: "compaction", id: "compact", timestamp, status: "completed", trigger: "manual" },
    {
      kind: "tool_call",
      id: "plan",
      timestamp,
      payload: {
        source: "agent",
        data: {
          name: "plan_approval",
          callId: "plan",
          provider: "opencode",
          error: null,
          status: "completed",
          detail: {
            type: "plan",
            text: "Plan evidence\n\n![plan beacon](https://example.invalid/plan.png)\n\n<img src='https://example.invalid/html.png'>\n\n[Open](file:///recipient/private.txt)",
          },
        },
      },
    },
    {
      kind: "plugin",
      id: "plugin",
      timestamp,
      pluginId: "unavailable-plugin",
      pluginItemId: "private-item",
      itemKind: "custom",
      version: 1,
      data: { text: "Do not run host plugins" },
    },
  ];
  mount({ streamItems: items, targetItemId: "answer" });
  await expect.poll(() => container.textContent).toContain("Shared answer");
  expect(container.querySelector('[data-paseo-markdown-tag="strong"]')?.textContent).toBe(
    "bold evidence",
  );
  expect(container.textContent).toContain("remote beacon: not loaded");
  expect(container.textContent).toContain("Image (not loaded)");
  expect(container.textContent).toContain("Plan evidence");
  expect(container.textContent).toContain("plan beacon: not loaded");
  expect(container.textContent).toContain("Context manually compacted");
  expect(container.textContent).not.toContain("Do not run host plugins");
  expect(container.querySelectorAll("img, a, textarea, input").length).toBe(0);
  expect(
    container.querySelectorAll(
      '[data-testid*="rewind"], [data-testid*="fork"], [data-testid*="composer"], [data-testid*="permission"]',
    ).length,
  ).toBe(0);
  expect(container.querySelectorAll('[data-testid="tool-call-badge"]').length).toBe(2);
  const badges = container.querySelectorAll<HTMLElement>('[data-testid="tool-call-badge"]');
  await userEvent.click(badges[0]!.querySelector<HTMLElement>('[role="button"]')!);
  await expect.poll(() => container.textContent).toContain("Reasoning evidence");
  await userEvent.click(badges[1]!.querySelector<HTMLElement>('[role="button"]')!);
  await expect.poll(() => container.textContent).toContain("Stored tool result");
  expect(
    performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.includes("example.invalid")).length,
  ).toBe(0);
});

test("loads newer pinned pages only on explicit request and resets view identity", async () => {
  let requests = 0;
  const onLoadNewer = () => {
    requests++;
    return true;
  };
  mount({
    streamItems: [user("target"), assistant("tail")],
    targetItemId: "target",
    newerPagination: { hasNewer: true, isLoadingNewer: false, onLoadNewer },
  });
  expect(requests).toBe(0);
  await userEvent.click(container.querySelector<HTMLElement>('[aria-label="Load newer history"]')!);
  expect(requests).toBe(1);
  mount({
    streamItems: [user("target"), assistant("tail")],
    targetItemId: "target",
    newerPagination: { hasNewer: true, isLoadingNewer: true, onLoadNewer },
  });
  expect(
    container.querySelector('[aria-label="Load newer history"]')?.getAttribute("aria-disabled"),
  ).toBe("true");
  mount({
    historyId: "different-pin",
    streamItems: [user("replacement")],
    targetItemId: "replacement",
  });
  expect(container.textContent).not.toContain("User prompt target");
  expect(container.querySelector('[data-testid="referenced-history-item"]')?.textContent).toContain(
    "User prompt replacement",
  );
});
