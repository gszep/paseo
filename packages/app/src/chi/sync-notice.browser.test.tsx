import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

import {
  SyncNoticeView,
  SyncWarningView,
  WorkspaceSyncNoticeView,
  WORKSPACE_NOTICE_TITLE,
  useSyncNoticeDismissal,
  syncNoticeReason,
  OMITTED_CONTENT_WARNING,
} from "./sync-notice-view";
import { isTerminalSyncError } from "./sync-destination";

const errorRef = { current: null as string | null };
const subjectRef = { current: "" };
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
  const { visible, dismiss } = useSyncNoticeDismissal(errorRef.current, subjectRef.current);
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
  errorRef.current = null;
  subjectRef.current = "";
  vi.clearAllMocks();
});

describe("SyncNoticeView", () => {
  it("explains divergence recovery and hides Retry without leaking a head or server diagnostic", () => {
    const error = "capture-head-diverged";
    const { container } = mount(
      <SyncNoticeView
        error={error}
        terminal={isTerminalSyncError(error)}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("preserve local work");
    expect(container.textContent).toContain("Removed sources are never recreated automatically");
    expect(container.textContent).toContain("OpenCode Fork");
    expect(button(container, "Retry")).toBeUndefined();
    expect(container.textContent).not.toContain(error);
  });
  it("invalid recovery proof stops automatic sync and hides Retry with fixed human recovery copy", () => {
    const error = "capture-recovery-invalid";
    const { container } = mount(
      <SyncNoticeView
        error={error}
        terminal={isTerminalSyncError(error)}
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain("could not verify the archived history");
    expect(container.textContent).toContain("Automatic sync stopped");
    expect(button(container, "Retry")).toBeUndefined();
    expect(container.textContent).not.toContain(error);
  });
  it("explains an uncertain timeout and offers a safe Retry", () => {
    const error = "chi-operation-timeout";
    const retry = vi.fn();
    const { container } = mount(
      <SyncNoticeView
        error={error}
        terminal={isTerminalSyncError(error)}
        onDismiss={vi.fn()}
        onRetry={retry}
      />,
    );
    expect(container.textContent).toContain("may already have committed");
    expect(container.textContent).toContain("same request");
    act(() => button(container, "Retry")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it("explains destination setup and paused history without exposing diagnostics", () => {
    const { container } = mount(
      <SyncNoticeView error="chi-destination-required" onDismiss={vi.fn()} onRetry={vi.fn()} />,
    );
    expect(container.textContent).toContain("Configure a Chi destination and repository mapping");
    expect(container.textContent).toContain("original endpoint");
    expect(container.textContent).not.toContain("chi-destination-required");
  });
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
    expect(container.textContent).toContain("A secret was detected in this batch. Sync stopped.");
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
  it("explains scan deadlines separately and retries the saved batch", () => {
    const retry = vi.fn();
    const { container } = mount(
      <SyncNoticeView error="capture-local-scan-timeout" onDismiss={vi.fn()} onRetry={retry} />,
    );
    expect(container.textContent).toContain("The secret scan exceeded its deadline");
    expect(container.textContent).toContain(
      "earlier attempts or batches may already have committed",
    );
    expect(container.textContent).not.toContain("Install gitleaks");
    act(() => button(container, "Retry")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
  it("explains a terminal cut-scan limit without claiming a secret finding", () => {
    const { container } = mount(
      <SyncNoticeView
        error="capture-local-cut-scan-limit"
        terminal
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(container.textContent).toContain(
      "This batch exceeds the local truncation safety-scan limit. Sync stopped.",
    );
    expect(container.textContent).not.toContain("A secret was detected");
    expect(button(container, "Retry")).toBeUndefined();
  });
  it("names the affected session for a workspace-level error instead of claiming this session", () => {
    const { container } = mount(
      <WorkspaceSyncNoticeView
        error="capture-local-cut-scan-limit"
        affected={[{ id: "b", title: "Opening new session" }]}
        terminal
        onDismiss={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    const element = container.querySelector('[data-testid="chi-sync-notice-workspace"]');
    expect(element).not.toBeNull();
    expect(element?.textContent).toContain(WORKSPACE_NOTICE_TITLE);
    expect(element?.textContent).toContain("Opening new session");
    expect(element?.textContent).not.toContain("For others to see this session");
    expect(button(container, "Retry")).toBeUndefined();
  });
  it("renders the non-blocking omitted-content warning with Dismiss only", () => {
    const { container } = mount(
      <SyncWarningView warning="capture-local-secret-omitted-content" onDismiss={vi.fn()} />,
    );
    const element = container.querySelector('[data-testid="chi-sync-warning"]');
    expect(element).not.toBeNull();
    expect(container.textContent).toContain(OMITTED_CONTENT_WARNING);
    expect(button(container, "Dismiss")).toBeInstanceOf(HTMLElement);
    expect(button(container, "Retry")).toBeUndefined();
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

  it("does not carry one session's dismissal onto another with the same error", () => {
    subjectRef.current = "session:a:s1:h1";
    errorRef.current = "capture-local-cut-scan-limit";
    const { root, container } = mount(<DismissProbe />);
    const probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.visible).toBe("true");

    act(() => (container.querySelector('[data-testid="dismiss"]') as HTMLButtonElement).click());
    expect(probe.dataset.visible).toBe("false");

    // Switch conversations: the same error code must show again for the new subject.
    subjectRef.current = "session:b:s2:h2";
    act(() => root.render(<DismissProbe />));
    expect(probe.dataset.visible).toBe("true");
  });
});
