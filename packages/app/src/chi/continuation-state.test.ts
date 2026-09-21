import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { fetchQueryOptions } from "@/data/query";
import {
  continuationRequestId,
  clearContinuationRequest,
  currentWorkspaceCatalog,
} from "./continuation-state";

const values = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => {
  return {
    default: {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    },
  };
});

describe("Chi continuation intake", () => {
  it("persists the request identity across concurrent clicks and reload until explicit pre-mutation recovery", async () => {
    const [id, concurrent] = await Promise.all([
      continuationRequestId("pin/host/workspace"),
      continuationRequestId("pin/host/workspace"),
    ]);
    expect(concurrent).toBe(id);
    expect(await continuationRequestId("pin/host/workspace")).toBe(id);
    vi.resetModules();
    const reloaded = await import("./continuation-state");
    expect(await reloaded.continuationRequestId("pin/host/workspace")).toBe(id);
    expect(await continuationRequestId("different-pin/host/workspace")).not.toBe(id);
    await clearContinuationRequest("pin/host/workspace");
    expect(await continuationRequestId("pin/host/workspace")).not.toBe(id);
  });

  it("suppresses A's placeholder rows while B's same-ID catalog is delayed, then reconciles removal", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveB!: (data: { serverId: string; entries: { id: string; name: string }[] }) => void;
    const a = { serverId: "A", entries: [{ id: "same", name: "A workspace" }] };
    const b = { serverId: "B", entries: [{ id: "same", name: "B workspace" }] };
    const options = (host: string) =>
      fetchQueryOptions({
        queryKey: ["chi-workspaces", host],
        dataShape: "list",
        staleTimeMs: 0,
        queryFn: () =>
          host === "A"
            ? Promise.resolve(a)
            : new Promise<typeof b>((resolve) => {
                resolveB = resolve;
              }),
      });
    const observer = new QueryObserver(client, options("A"));
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    expect(currentWorkspaceCatalog("A", observer.getCurrentResult())).toEqual(a.entries);
    observer.setOptions(options("B"));
    expect(observer.getCurrentResult().isPlaceholderData).toBe(true);
    expect(currentWorkspaceCatalog("B", observer.getCurrentResult())).toEqual([]);
    resolveB(b);
    await observer.refetch();
    expect(currentWorkspaceCatalog("B", observer.getCurrentResult())).toEqual(b.entries);
    client.setQueryData(["chi-workspaces", "B"], { serverId: "B", entries: [] });
    expect(
      currentWorkspaceCatalog("B", observer.getCurrentResult()).find((row) => row.id === "same"),
    ).toBeUndefined();
    unsubscribe();
    client.clear();
  });
});
