import React, { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { StreamItem } from "@/types/stream";
import { ReadOnlyStreamView, type ReadOnlyStreamViewProps } from "./read-only-view";
import { PROMPT_JUMP_TOP_INSET_PX } from "./prompt-jump-settle";
import { HIGHLIGHT_CACHE_LIMIT, tokenizeToLines } from "@/utils/highlight-cache";
import { useMermaidRenderModel } from "@/components/markdown/fence/mermaid/use-render-model";
import {
  ProtectedPresentationProvider,
  useProtectedPresentationBridge,
} from "@/components/protected-presentation";
import { ToolCallDetailsContent } from "@/components/tool-call-details";

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

type MermaidModel = ReturnType<typeof useMermaidRenderModel>;

function observations<T>() {
  const values: T[] = [];
  return {
    values,
    receive: (value: T) => {
      values.push(value);
    },
  };
}

const MODAL_CANARY_DETAIL = {
  type: "read" as const,
  filePath: "/supplied/modal.ts",
  content: 'const privateModal143 = "canary";',
};

function MermaidCacheProbe({
  source,
  onModel,
}: {
  source: string;
  onModel: (model: MermaidModel) => void;
}) {
  const model = useMermaidRenderModel({ source, phase: "complete", colorScheme: "dark" });
  useLayoutEffect(() => onModel(model), [model, onModel]);
  return <output>{model.state.visible ? "cached diagram" : "uncached diagram"}</output>;
}

// Fill the existing bounded cache. Any new protected entry (or a broad cache
// clear) evicts this unrelated oldest entry and breaks its public identity reuse.
function ordinaryCacheWitness(prefix: string) {
  const code = `const ${prefix}0 = true;`;
  const tokens = tokenizeToLines(code, "ts");
  expect(tokens).not.toBeNull();
  for (let index = 1; index < HIGHLIGHT_CACHE_LIMIT; index++) {
    tokenizeToLines(`const ${prefix}${index} = true;`, "ts");
  }
  return { code, tokens };
}

test("protected code, Mermaid, and expanded file details never populate shared caches across revocation", async () => {
  const unrelated = ordinaryCacheWitness("ordinaryReader143_");
  const code = 'const protectedFence143 = "private canary";';
  const diagram = "graph TD; protectedDiagram143-->privateCanary;";
  const file = 'const protectedRead143 = "private file canary";';
  const editBefore = 'const protectedEdit143 = "before";';
  const editAfter = 'const protectedEdit143 = "after";';
  const items: StreamItem[] = [
    assistant("cache-canary", `\`\`\`ts\n${code}\n\`\`\`\n\n\`\`\`mermaid\n${diagram}\n\`\`\``),
    {
      kind: "tool_call",
      id: "read-canary",
      timestamp,
      payload: {
        source: "agent",
        data: {
          provider: "opencode",
          name: "read_file",
          callId: "read-canary",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "/supplied/canary.ts", content: file },
        },
      },
    },
    {
      kind: "tool_call",
      id: "edit-canary",
      timestamp,
      payload: {
        source: "agent",
        data: {
          provider: "opencode",
          name: "edit_file",
          callId: "edit-canary",
          status: "completed",
          error: null,
          detail: {
            type: "edit",
            filePath: "/supplied/canary.ts",
            oldString: editBefore,
            newString: editAfter,
          },
        },
      },
    },
  ];
  mount({ streamItems: items });
  await expect.poll(() => container.textContent).toContain(code);
  expect(container.textContent).toContain(diagram);
  expect(container.querySelectorAll("iframe, [data-testid='mermaid-viewport']").length).toBe(0);
  const badges = container.querySelectorAll<HTMLElement>(
    '[data-testid="tool-call-badge"] [role="button"]',
  );
  await userEvent.click(badges[0]!);
  await expect.poll(() => container.textContent).toContain(file);
  await userEvent.click(badges[1]!);
  await expect.poll(() => container.textContent).toContain("protectedEdit143");

  act(() => root!.render(<div>Context unavailable</div>));
  expect(container.textContent).toBe("Context unavailable");
  expect(tokenizeToLines(unrelated.code, "ts")).toBe(unrelated.tokens);

  const { values: models, receive: capture } = observations<MermaidModel>();
  act(() => root!.render(<MermaidCacheProbe source={diagram} onModel={capture} />));
  expect(models.at(-1)!.state.visible).toBeNull();
});

test("late Mermaid completion cannot repopulate a revoked surface and unrelated cached diagrams survive", async () => {
  const ordinarySource = "graph TD; ordinaryReader143-->cachedDiagram;";
  const delayedSource = "graph TD; delayedPrivate143-->revokedDiagram;";
  const { values: models, receive: capture } = observations<MermaidModel>();
  mount({ streamItems: [] });
  act(() => root!.render(<MermaidCacheProbe source={ordinarySource} onModel={capture} />));
  const initial = models.at(-1)!;
  act(() =>
    initial.rendered({
      revision: initial.state.revision,
      source: ordinarySource,
      colorScheme: "dark",
      dimensions: { width: 180, height: 80 },
    }),
  );
  act(() => root!.render(<div>Different surface</div>));
  act(() => root!.render(<MermaidCacheProbe source={delayedSource} onModel={capture} />));
  const pending = models.at(-1)!;
  expect(pending.state.visible).toBeNull();
  act(() => root!.render(<div>Context unavailable</div>));
  await act(async () => {
    await Promise.resolve();
    pending.rendered({
      revision: pending.state.revision,
      source: delayedSource,
      colorScheme: "dark",
      dimensions: { width: 200, height: 100 },
    });
  });
  act(() => root!.render(<MermaidCacheProbe source={delayedSource} onModel={capture} />));
  expect(models.at(-1)!.state.visible).toBeNull();
  act(() => root!.render(<div>Different surface</div>));
  act(() => root!.render(<MermaidCacheProbe source={ordinarySource} onModel={capture} />));
  expect(models.at(-1)!.state.visible).toEqual({
    source: ordinarySource,
    colorScheme: "dark",
    width: 180,
    height: 80,
  });
});

test("the protected Mermaid model neither reads nor writes the ordinary diagram cache", () => {
  const source = "graph TD; protectedModel143-->canary;";
  const { values: models, receive: capture } = observations<MermaidModel>();
  mount({ streamItems: [] });
  act(() =>
    root!.render(
      <ProtectedPresentationProvider>
        <MermaidCacheProbe source={source} onModel={capture} />
      </ProtectedPresentationProvider>,
    ),
  );
  const protectedModel = models.at(-1)!;
  act(() =>
    protectedModel.rendered({
      revision: protectedModel.state.revision,
      source,
      colorScheme: "dark",
      dimensions: { width: 100, height: 50 },
    }),
  );
  expect(models.at(-1)!.state.visible?.source).toBe(source);
  act(() => root!.render(<div>Context unavailable</div>));
  act(() => root!.render(<MermaidCacheProbe source={source} onModel={capture} />));
  const ordinaryModel = models.at(-1)!;
  expect(ordinaryModel.state.visible).toBeNull();
  act(() =>
    ordinaryModel.rendered({
      revision: ordinaryModel.state.revision,
      source,
      colorScheme: "dark",
      dimensions: { width: 100, height: 50 },
    }),
  );
  act(() =>
    root!.render(
      <ProtectedPresentationProvider>
        <MermaidCacheProbe source={source} onModel={capture} />
      </ProtectedPresentationProvider>,
    ),
  );
  expect(models.at(-1)!.state.visible).toBeNull();
});

function PresentationBridgeCapture({
  onBridge,
}: {
  onBridge: (bridge: ReturnType<typeof useProtectedPresentationBridge>) => void;
}) {
  const bridge = useProtectedPresentationBridge();
  useLayoutEffect(() => onBridge(bridge), [bridge, onBridge]);
  return null;
}

test("the native detail-modal context bridge preserves the protected cache policy at a separate root", () => {
  const unrelated = ordinaryCacheWitness("ordinaryModalReader143_");
  const { values: bridges, receive: capture } =
    observations<ReturnType<typeof useProtectedPresentationBridge>>();
  mount({ streamItems: [] });
  act(() =>
    root!.render(
      <ProtectedPresentationProvider>
        <PresentationBridgeCapture onBridge={capture} />
      </ProtectedPresentationProvider>,
    ),
  );
  const modalContainer = document.createElement("div");
  document.body.append(modalContainer);
  const modalRoot = createRoot(modalContainer);
  try {
    act(() =>
      modalRoot.render(bridges[0]!(<ToolCallDetailsContent detail={MODAL_CANARY_DETAIL} />)),
    );
    expect(modalContainer.textContent).toContain(MODAL_CANARY_DETAIL.content);
    act(() => root!.render(<div>Context unavailable</div>));
  } finally {
    act(() => modalRoot.unmount());
    modalContainer.remove();
  }
  expect(tokenizeToLines(unrelated.code, "ts")).toBe(unrelated.tokens);
});
