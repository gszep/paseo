import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_REPOSITORIES_OPTION_ID } from "./inbox-model";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

// Drive the compact/desktop layout without a real breakpoint.
const compact = vi.hoisted(() => ({ value: false }));

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return { ...actual, useIsCompactFormFactor: () => compact.value };
});

import { RepositoryFilter } from "./repository-filter";

const noopSelect = () => undefined;
const repoOptionTestID = (id: string) => `inbox-repo-filter-item-${id}`;

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mountFilter(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <RepositoryFilter
        repositories={["github:acme/one", "github:acme/two"]}
        selected={ALL_REPOSITORIES_OPTION_ID}
        onSelect={noopSelect}
        triggerTestID="inbox-repo-filter-trigger"
        optionTestID={repoOptionTestID}
      />,
    ),
  );
  mounted.push({ root, container });
  return container;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("RepositoryFilter", () => {
  // Regression: the trigger used to be passed as Combobox children, which only
  // mount inside the popup, so it was unreachable while closed.
  it.each([false, true])(
    "keeps the trigger mounted and labelled while the picker is closed (compact=%s)",
    (value) => {
      compact.value = value;
      const container = mountFilter();
      const trigger = container.querySelector('[data-testid="inbox-repo-filter-trigger"]');
      expect(trigger).toBeInstanceOf(HTMLElement);
      expect(trigger?.textContent).toContain("All repositories");
      expect(document.querySelector('[data-testid="combobox-desktop-container"]')).toBeNull();
    },
  );

  it("opens the picker from the trigger", async () => {
    compact.value = false;
    const container = mountFilter();
    act(() =>
      (container.querySelector('[data-testid="inbox-repo-filter-trigger"]') as HTMLElement).click(),
    );
    await nextFrame();
    expect(document.querySelector('[data-testid="combobox-desktop-container"]')).not.toBeNull();
    expect(
      document.querySelector('[data-testid="inbox-repo-filter-item-github:acme/one"]'),
    ).not.toBeNull();
  });
});
