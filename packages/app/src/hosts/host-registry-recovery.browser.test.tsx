import React, { act, useCallback, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { I18nextProvider } from "react-i18next";
import { i18n } from "@/i18n/i18next";
import { HostRuntimeStore, type HostRuntimeStorage } from "@/runtime/host-runtime";
import { HostRegistryBoundary } from "./host-registry-recovery";

const registryKey = "@paseo:daemon-registry";
const host = {
  serverId: "srv_registry_test",
  label: "Saved laptop",
  connections: [{ type: "directSocket", path: "/synthetic.sock" }],
};
const stores: HostRuntimeStore[] = [];
let root: Root;
let container: HTMLDivElement;

function makeStore(storage: HostRuntimeStorage = AsyncStorage) {
  const store = new HostRuntimeStore({
    storage,
    deps: {
      createClient: () => {
        throw new Error("Synthetic host stays offline");
      },
      connectToDaemon: async () => {
        throw new Error("Synthetic host stays offline");
      },
      getClientId: async () => "cid_registry_test",
    },
  });
  stores.push(store);
  return store;
}

function Screen({ store }: { store: HostRuntimeStore }) {
  const retry = useCallback(() => {
    void store.boot();
  }, [store]);
  const status = useSyncExternalStore(
    (notify) => store.subscribeHostList(notify),
    () => store.getHostRegistryStatus(),
  );
  return (
    <I18nextProvider i18n={i18n}>
      <HostRegistryBoundary status={status} onRetry={retry}>
        {store.getHosts().length ? (
          <div>
            {store
              .getHosts()
              .map((entry) => entry.label)
              .join(", ")}
          </div>
        ) : (
          <div>Pair a host</div>
        )}
      </HostRegistryBoundary>
    </I18nextProvider>
  );
}

beforeEach(async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  localStorage.setItem("@paseo:e2e", "1");
  localStorage.setItem(registryKey, JSON.stringify([host]));
  container = document.createElement("div");
  container.style.cssText = "height: 100vh; display: flex; flex-direction: column";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const store of stores.splice(0)) store.syncHosts([]);
  localStorage.removeItem(registryKey);
  localStorage.removeItem("@paseo:e2e");
  vi.unstubAllGlobals();
});

describe("saved hosts in browser storage", () => {
  it("shows recovery instead of pairing after a read error; Retry restores the same host", async () => {
    let unavailable = true;
    const before = localStorage.getItem(registryKey);
    const store = makeStore({
      ...AsyncStorage,
      getItem: async (key) => {
        if (key === registryKey && unavailable) throw new DOMException("Denied", "SecurityError");
        return AsyncStorage.getItem(key);
      },
    });
    await act(async () => {
      root.render(<Screen store={store} />);
      await store.boot();
    });
    expect(container.textContent).toContain("Saved hosts could not be loaded");
    expect(container.textContent).not.toContain("Pair a host");
    expect(localStorage.getItem(registryKey)).toBe(before);
    await page.screenshot({ path: "../../.vitest-screenshots/registry-read-error.png" });
    unavailable = false;
    await act(async () => {
      await page.getByTestId("host-registry-retry").click();
    });
    await expect.poll(() => container.textContent).toBe("Saved laptop");
    expect(localStorage.getItem(registryKey)).toBe(before);
    await page.screenshot({ path: "../../.vitest-screenshots/registry-read-recovered.png" });
  });

  it("retains malformed data and a valid neighbour across reopening without showing unpaired", async () => {
    const raw = JSON.stringify([host, { ...host, serverId: "srv_future", unknown: true }]);
    localStorage.setItem(registryKey, raw);
    const first = makeStore();
    await act(async () => {
      root.render(<Screen store={first} />);
      await first.boot();
    });
    expect(container.textContent).toContain("Saved hosts could not be loaded");
    first.setAppVisible(false);
    first.syncHosts([]);
    const reopened = makeStore();
    await act(async () => {
      root.render(<Screen store={reopened} />);
      await reopened.boot();
    });
    expect(container.textContent).not.toContain("Pair a host");
    expect(localStorage.getItem(registryKey)).toBe(raw);
  });

  it("propagates a browser quota failure without publishing a successfully paired host", async () => {
    const before = localStorage.getItem(registryKey);
    const store = makeStore({
      ...AsyncStorage,
      setItem: async () => {
        throw new DOMException("Full", "QuotaExceededError");
      },
    });
    await store.boot();
    await expect(
      store.upsertRelayConnection({
        serverId: "srv_new",
        relayEndpoint: "relay.invalid:443",
        daemonPublicKeyB64: "synthetic",
      }),
    ).rejects.toThrow();
    expect(localStorage.getItem(registryKey)).toBe(before);
    expect(store.getHosts().map((entry) => entry.serverId)).toEqual([host.serverId]);
    store.setAppVisible(false);
    store.syncHosts([]);
    const reopened = makeStore();
    await reopened.boot();
    expect(reopened.getHosts().map((entry) => entry.serverId)).toEqual([host.serverId]);
  });
});
