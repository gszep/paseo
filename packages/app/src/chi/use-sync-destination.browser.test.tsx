import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

// Imported from the pure module on purpose: the hook's runtime imports pull the
// whole navigation graph into the browser dependency optimizer.
import {
  deriveSyncDestinationState,
  isTerminalSecretError,
  syncDestinationQueryKey,
} from "./sync-destination";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}
function probe(container: HTMLElement) {
  return container.querySelector('[data-testid="probe"]') as HTMLElement;
}

function Probe() {
  const state = deriveSyncDestinationState({
    response: {
      destination: {
        id: "henkaku",
        name: "Henkaku",
        endpoint: "https://chi-backend.invalid",
        audience: "shared",
        actor: "github:sava",
        matchedRule: "github:fixture/repo",
      },
      pending: true,
      error: null,
      mentionsAvailable: true,
    },
    loading: false,
    retry: () => undefined,
  });
  return (
    <span
      data-testid="probe"
      data-destination={state.destination?.id ?? "none"}
      data-pending={String(state.pending)}
      data-loading={String(state.loading)}
      data-error={state.error ?? ""}
      data-mentions={String(state.mentionsAvailable)}
      data-actor={state.destination?.actor ?? ""}
      data-rule={state.destination?.matchedRule ?? ""}
    />
  );
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  vi.clearAllMocks();
});

describe("sync destination state", () => {
  it("maps a resolved destination, pending state and error", () => {
    const element = probe(mount(<Probe />));
    expect(element.dataset.destination).toBe("henkaku");
    expect(element.dataset.pending).toBe("true");
    expect(element.dataset.loading).toBe("false");
    expect(element.dataset.error).toBe("");
    expect(element.dataset.mentions).toBe("true");
    expect(element.dataset.actor).toBe("github:sava");
    expect(element.dataset.rule).toBe("github:fixture/repo");
  });

  it("treats a missing response as loading, never as a local verdict", () => {
    const state = deriveSyncDestinationState({ response: null, loading: true, retry: vi.fn() });
    expect(state.loading).toBe(true);
    expect(state.destination).toBeNull();
    expect(state.pending).toBe(false);
    expect(state.error).toBeNull();
    expect(state.mentionsAvailable).toBe(false);
  });

  it("defaults mentions unavailable for a peer destination", () => {
    const state = deriveSyncDestinationState({
      response: { destination: null, pending: false, error: null },
      loading: false,
      retry: vi.fn(),
    });
    expect(state.mentionsAvailable).toBe(false);
  });

  it("keeps a safe failure reason and pending state", () => {
    const state = deriveSyncDestinationState({
      response: { destination: null, pending: true, error: "evidence-http-503" },
      loading: false,
      retry: vi.fn(),
    });
    expect(state.error).toBe("evidence-http-503");
    expect(state.pending).toBe(true);
  });

  it("exposes a stable query key", () => {
    expect(syncDestinationQueryKey("host", "workspace")).toEqual([
      "chi-sync-status",
      "host",
      "workspace",
    ]);
  });

  it("classifies terminal secret-scan errors", () => {
    expect(isTerminalSecretError("capture-local-secret-rejected")).toBe(true);
    expect(isTerminalSecretError("evidence-http-422-server-secret-scan-rejected")).toBe(true);
    // A missing scanner is retryable once gitleaks is installed.
    expect(isTerminalSecretError("capture-local-scanner-unavailable")).toBe(false);
    expect(isTerminalSecretError("evidence-http-503")).toBe(false);
    expect(isTerminalSecretError(null)).toBe(false);
  });
});
