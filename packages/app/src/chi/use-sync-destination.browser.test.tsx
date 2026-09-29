import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

const clientRef = vi.hoisted(() => ({
  current: null as null | {
    chiSyncStatus: ReturnType<typeof vi.fn>;
  },
}));
const queryRef = vi.hoisted(() => ({
  current: {
    isSuccess: false,
    isLoading: true,
    isFetching: true,
    data: undefined as unknown,
    refetch: vi.fn(async () => undefined),
  },
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => clientRef.current,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { host: { serverInfo: { features: { chiNative: true } } } } }),
}));
vi.mock("@/data/query", () => ({
  useFetchQuery: () => queryRef.current,
}));

import { syncDestinationQueryKey, useSyncDestination } from "./use-sync-destination";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  mounted.push({ root, container });
  return container;
}
function Probe() {
  const state = useSyncDestination("host", "workspace");
  return (
    <div>
      <span
        data-testid="probe"
        data-destination={state.destination?.id ?? "none"}
        data-loading={String(state.loading)}
        data-error={state.error ?? ""}
        data-pending={String(state.pending)}
      />
      <button type="button" data-testid="retry" onClick={state.retry}>
        retry
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

describe("useSyncDestination", () => {
  it("reports loading until the first response and never treats it as local", () => {
    clientRef.current = { chiSyncStatus: vi.fn() };
    queryRef.current = {
      isSuccess: false,
      isLoading: true,
      isFetching: true,
      data: undefined,
      refetch: vi.fn(async () => undefined),
    };
    const container = mount();
    const probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.loading).toBe("true");
    expect(probe.dataset.destination).toBe("none");
  });

  it("maps a resolved destination, pending state and error", () => {
    clientRef.current = { chiSyncStatus: vi.fn() };
    queryRef.current = {
      isSuccess: true,
      isLoading: false,
      isFetching: false,
      data: {
        outcome: "ready",
        destination: {
          id: "henkaku",
          name: "Henkaku",
          endpoint: "https://chi-backend.invalid",
          audience: "shared",
        },
        pending: true,
        error: null,
      },
      refetch: vi.fn(async () => undefined),
    };
    const container = mount();
    const probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.destination).toBe("henkaku");
    expect(probe.dataset.pending).toBe("true");
    expect(probe.dataset.loading).toBe("false");
    expect(probe.dataset.error).toBe("");
  });

  it("issues a retry action and refetches", async () => {
    const chiSyncStatus = vi.fn(async () => ({ outcome: "ready" }));
    const refetch = vi.fn(async () => undefined);
    clientRef.current = { chiSyncStatus };
    queryRef.current = {
      isSuccess: true,
      isLoading: false,
      isFetching: false,
      data: { outcome: "ready", destination: null, pending: false, error: "evidence-http-503" },
      refetch,
    };
    const container = mount();
    const probe = container.querySelector('[data-testid="probe"]') as HTMLElement;
    expect(probe.dataset.error).toBe("evidence-http-503");
    await act(async () => {
      (container.querySelector('[data-testid="retry"]') as HTMLButtonElement).click();
    });
    expect(chiSyncStatus).toHaveBeenCalledWith({ workspaceId: "workspace", action: "retry" });
    expect(refetch).toHaveBeenCalled();
  });

  it("exposes a stable query key", () => {
    expect(syncDestinationQueryKey("host", "workspace")).toEqual([
      "chi-sync-status",
      "host",
      "workspace",
    ]);
  });
});
