import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

import { SyncNoticeView, useSyncNoticeDismissal, syncNoticeReason } from "./sync-notice-view";

const errorRef = { current: null as string | null };
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return { root, container };
}
function notice(container: HTMLElement) {
  return container.querySelector('[data-testid="chi-sync-notice"]');
}
function button(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("*")).find(
    (element) => element.textContent === label,
  ) as HTMLElement | undefined;
}

function DismissProbe() {
  const { visible, dismiss } = useSyncNoticeDismissal(errorRef.current);
  return (
    <div>
      <span data-testid="probe" data-visible={String(visible)} />
      <button type="button" data-testid="dismiss" onClick={dismiss}>
        dismiss
      </button>
    </div>
  );
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  vi.clearAllMocks();
});

describe("SyncNoticeView", () => {
  it("renders the required copy, a safe reason and both actions", () => {
    const { container } = mount(
      <SyncNoticeView error="evidence-http-503" onDismiss={vi.fn()} onRetry={vi.fn()} />,
    );
    const element = notice(container);
    expect(element).not.toBeNull();
    expect(element?.textContent).toContain(
      "For others to see this session and for its mentions to appear, sync needs to succeed.",
    );
    expect(element?.textContent).toContain(syncNoticeReason("evidence-http-503"));
    expect(button(container, "Dismiss")).toBeInstanceOf(HTMLElement);
    expect(button(container, "Retry")).toBeInstanceOf(HTMLElement);
  });

  it("routes dismiss and retry through their callbacks", () => {
    const onDismiss = vi.fn();
    const onRetry = vi.fn();
    const { container } = mount(
      <SyncNoticeView error="chi-destination-unmapped" onDismiss={onDismiss} onRetry={onRetry} />,
    );
    act(() => button(container, "Dismiss")!.click());
    act(() => button(container, "Retry")!.click());
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("hides Retry for a terminal secret rejection and shows the safe copy", () => {
    const { container } = mount(
      <SyncNoticeView
        error="capture-local-secret-rejected"
        terminal
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(button(container, "Retry")).toBeUndefined();
    expect(container.textContent).toContain(
      "A secret was detected in this session's history. Nothing was uploaded.",
    );
    expect(container.textContent).not.toContain("Reconnect");
  });

  it("keeps Retry for a missing local scanner and shows the host-dependency copy", () => {
    const { container } = mount(
      <SyncNoticeView
        error="capture-local-scanner-unavailable"
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(button(container, "Retry")).toBeInstanceOf(HTMLElement);
    expect(container.textContent).toContain("The secret scanner is unavailable on this host");
  });
});

describe("useSyncNoticeDismissal", () => {
  it("hides on dismissal and clears on success so a later failure shows again", () => {
    errorRef.current = "chi-destination-unmapped";
    const { root, container } = mount(<DismissProbe />);
    const probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.visible).toBe("true");

    act(() => (container.querySelector('[data-testid="dismiss"]') as HTMLButtonElement).click());
    expect(probe.dataset.visible).toBe("false");

    // Success clears the dismissal.
    errorRef.current = null;
    act(() => root.render(<DismissProbe />));
    expect(probe.dataset.visible).toBe("false");

    // A later distinct failure shows again.
    errorRef.current = "evidence-http-503";
    act(() => root.render(<DismissProbe />));
    expect(probe.dataset.visible).toBe("true");
  });
});
