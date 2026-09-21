import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { fetchQueryOptions } from "@/data/query";
import {
  createContinuationRequests,
  currentWorkspaceCatalog,
  type ContinuationStorage,
} from "./continuation-state";

function memoryStorage(): ContinuationStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

describe("Chi continuation intake", () => {
  it("persists the request identity across concurrent clicks and reload until explicit pre-mutation recovery", async () => {
    const storage = memoryStorage();
    let generated = 0;
    const generateUuid = () => `request-${++generated}`;
    const requests = createContinuationRequests({ storage, generateUuid });
    const [id, concurrent] = await Promise.all([
      requests.requestId("pin/host/workspace"),
      requests.requestId("pin/host/workspace"),
    ]);
    expect(concurrent).toBe(id);
    expect(await requests.requestId("pin/host/workspace")).toBe(id);
    const reloaded = createContinuationRequests({ storage, generateUuid });
    expect(await reloaded.requestId("pin/host/workspace")).toBe(id);
    expect(generated).toBe(1);
    expect(await reloaded.requestId("different-pin/host/workspace")).not.toBe(id);
    await reloaded.clear("pin/host/workspace");
    expect(await reloaded.requestId("pin/host/workspace")).not.toBe(id);
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
