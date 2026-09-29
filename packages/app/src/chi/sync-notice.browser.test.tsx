import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

const stateRef = vi.hoisted(() => ({
  current: {
    destination: null as null | { id: string; name: string; endpoint: string; audience: string },
    pending: false,
    error: null as string | null,
    loading: false,
    retry: vi.fn(),
  },
}));

vi.mock("./use-sync-destination", () => ({
  useSyncDestination: () => stateRef.current,
}));

import { WorkspaceSyncNotice, syncNoticeReason } from "./sync-notice";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function render(error: string | null) {
  stateRef.current = {
    destination: null,
    pending: false,
    error,
    loading: false,
    retry: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<WorkspaceSyncNotice serverId="host" workspaceId="workspace" />));
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

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  vi.clearAllMocks();
});

describe("WorkspaceSyncNotice", () => {
  it("renders the required copy and a safe reason for a failure", () => {
    const { container } = render("evidence-http-503");
    const element = notice(container);
    expect(element).not.toBeNull();
    expect(element?.textContent).toContain("Sync needs to succeed");
    expect(element?.textContent).toContain(syncNoticeReason("evidence-http-503"));
  });

  it("is absent without an error and never a local verdict while loading", () => {
    const { container } = render(null);
    expect(notice(container)).toBeNull();
  });

  it("dismisses without clearing pending state, and success clears the notice", () => {
    const { root, container } = render("chi-destination-unmapped");
    expect(notice(container)).not.toBeNull();
    act(() => button(container, "Dismiss")!.click());
    expect(notice(container)).toBeNull();
    // A success response clears the dismissal so a later failure shows again.
    stateRef.current = { ...stateRef.current, error: null };
    act(() => root.render(<WorkspaceSyncNotice serverId="host" workspaceId="workspace" />));
    expect(notice(container)).toBeNull();
    stateRef.current = { ...stateRef.current, error: "evidence-http-503" };
    act(() => root.render(<WorkspaceSyncNotice serverId="host" workspaceId="workspace" />));
    expect(notice(container)).not.toBeNull();
  });

  it("retries through the shared status hook", () => {
    const { container } = render("evidence-http-503");
    const retry = stateRef.current.retry;
    act(() => button(container, "Retry")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });
});
