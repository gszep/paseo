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
  isTerminalSyncError,
  syncDestinationQueryKey,
} from "./sync-destination";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useSyncDestination } from "./use-sync-destination";

// The live enabled context is driven here; the RPC transport is a mock, but the
// query client and the hook under test are real.
const host = vi.hoisted(() => ({
  connected: true,
  supported: true,
  chiSyncStatus: vi.fn(),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (id: string) => (id ? { chiSyncStatus: host.chiSyncStatus } : null),
  useHostRuntimeIsConnected: () => host.connected,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        "host-1": {
          serverInfo: { features: { chiAppendV3: host.supported } },
          agents: new Map(),
        },
      },
    }),
}));

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
    available: true,
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
  host.connected = true;
  host.supported = true;
  host.chiSyncStatus.mockReset();
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
    const state = deriveSyncDestinationState({
      response: null,
      loading: true,
      available: false,
      retry: vi.fn(),
    });
    expect(state.loading).toBe(true);
    expect(state.available).toBe(false);
    expect(state.destination).toBeNull();
    expect(state.pending).toBe(false);
    expect(state.error).toBeNull();
    expect(state.mentionsAvailable).toBe(false);
  });

  it("defaults mentions unavailable for a peer destination", () => {
    const state = deriveSyncDestinationState({
      response: { destination: null, pending: false, error: null },
      loading: false,
      available: true,
      retry: vi.fn(),
    });
    expect(state.mentionsAvailable).toBe(false);
  });

  it("keeps a safe failure reason and pending state", () => {
    const state = deriveSyncDestinationState({
      response: { destination: null, pending: true, error: "evidence-http-503" },
      loading: false,
      available: true,
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
    expect(isTerminalSyncError("capture-local-secret-rejected")).toBe(true);
    expect(isTerminalSyncError("capture-local-cut-scan-limit")).toBe(true);
    expect(isTerminalSyncError("native-capture-bounds")).toBe(true);
    expect(isTerminalSyncError("evidence-http-422-server-secret-scan-rejected")).toBe(true);
    // A missing scanner is retryable once gitleaks is installed.
    expect(isTerminalSyncError("capture-local-scanner-unavailable")).toBe(false);
    expect(isTerminalSyncError("evidence-http-503")).toBe(false);
    expect(isTerminalSyncError(null)).toBe(false);
  });
});

function LifecycleProbe() {
  const state = useSyncDestination("host-1", "ws-1");
  return (
    <span
      data-testid="lifecycle-probe"
      data-available={String(state.available)}
      data-loading={String(state.loading)}
      data-error={state.error ?? ""}
    />
  );
}

describe("useSyncDestination readiness", () => {
  function renderProbe() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = () =>
      root.render(
        <QueryClientProvider client={client}>
          <LifecycleProbe />
        </QueryClientProvider>,
      );
    act(render);
    mounted.push({ root, container });
    return { render, container };
  }

  function lifecycleProbe(container: HTMLElement) {
    return container.querySelector('[data-testid="lifecycle-probe"]') as HTMLElement;
  }

  async function flush(ms = 0) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  async function waitForAvailable(container: HTMLElement, expected: boolean, timeoutMs = 4000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (lifecycleProbe(container).dataset.available === String(expected)) return;
      await flush(25);
    }
    expect(lifecycleProbe(container).dataset.available).toBe(String(expected));
  }

  const ready = (error: string | null = null) => ({
    outcome: "ready" as const,
    destination: {
      id: "d",
      name: "D",
      endpoint: "https://chi.invalid",
      audience: "shared" as const,
    },
    pending: false,
    error,
    warning: null,
    mentionsAvailable: true,
  });

  it("gates readiness on the live enabled context, not the retained query success", async () => {
    host.connected = true;
    host.supported = true;
    host.chiSyncStatus.mockResolvedValue(ready());
    const { render, container } = renderProbe();
    await waitForAvailable(container, true);
    expect(lifecycleProbe(container).dataset.loading).toBe("false");

    // Disconnect: the query is disabled but TanStack keeps isSuccess, so loading
    // stays false. Readiness must drop even though `loading` does not.
    host.connected = false;
    act(render);
    await flush(50);
    expect(lifecycleProbe(container).dataset.available).toBe("false");
    expect(lifecycleProbe(container).dataset.loading).toBe("false");

    // Capability loss: same retained success, no current verdict.
    host.connected = true;
    host.supported = false;
    act(render);
    await flush(50);
    expect(lifecycleProbe(container).dataset.available).toBe("false");
    expect(lifecycleProbe(container).dataset.loading).toBe("false");

    // Reconnect with the capability: a current verdict is available again.
    host.supported = true;
    host.connected = true;
    act(render);
    await waitForAvailable(container, true);
  });

  it("surfaces a resolved workspace/auth error but suppresses a denied refetch", async () => {
    host.connected = true;
    host.supported = true;
    host.chiSyncStatus.mockResolvedValue(ready("chi-repository-unauthorized"));
    const { render, container } = renderProbe();
    await waitForAvailable(container, true);
    expect(lifecycleProbe(container).dataset.error).toBe("chi-repository-unauthorized");

    // Denied refetch: the query errors, isSuccess becomes false, readiness drops.
    host.chiSyncStatus.mockRejectedValue(new Error("chi-denied"));
    host.connected = false;
    act(render);
    await flush(50);
    host.connected = true;
    act(render);
    await waitForAvailable(container, false);
  });
});
