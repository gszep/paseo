import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { AtSign } from "lucide-react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { InboxCoverageNotice } from "./inbox-coverage";
import { inboxTransportQueryOptions, useInboxQuery } from "./inbox-query";
import { useFetchQuery } from "@/data/query";
import { ChiOperationError, type ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { createMentionScope, mentionQueryKey } from "./mention-context";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];
const noop = () => {};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return { root, container };
}
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

test("incomplete coverage is visible and an incomplete zero unread count is not hidden", () => {
  const notice = mount(<InboxCoverageNotice unavailableRepos={["github:fixture/broken"]} />);
  expect(notice.container.textContent).toContain(
    "Some repositories unavailable — inbox incomplete",
  );
  expect(notice.container.textContent).toContain("Unread count is incomplete");
  for (const count of [0, 3]) {
    const { container } = mount(
      <SidebarHeaderRow
        icon={AtSign}
        label="Mentions"
        onPress={noop}
        badge={count}
        badgeIncomplete
      />,
    );
    expect(container.textContent).toContain(`${count}+`);
    expect(
      container.querySelector(`[aria-label="${count} unread mentions, count incomplete"]`),
    ).not.toBeNull();
  }
  act(() => notice.root.render(<InboxCoverageNotice unavailableRepos={[]} />));
  expect(notice.container.textContent).toBe("");
  expect(mount(<InboxCoverageNotice />).container.textContent).toBe("");
  const complete = mount(
    <SidebarHeaderRow icon={AtSign} label="Mentions" onPress={noop} badge={3} />,
  );
  expect(complete.container.textContent).not.toContain("+");
  expect(complete.container.querySelector('[aria-label="3 unread mentions"]')).not.toBeNull();
});

test("invalid availability cursor discards old pages and automatically restarts from page one", async () => {
  const cache = new QueryClient();
  const context: ChiMentionContext = {
    actor: "github:alice",
    repo: "*",
    generation: "a".repeat(64),
  };
  let recovered = false;
  const calls: Array<string | undefined> = [];
  let query!: ReturnType<typeof useInboxQuery>;
  function Probe() {
    query = useInboxQuery({
      queryKey: ["coverage-test"],
      inbox: true,
      enabled: true,
      context,
      run: async (operation) => {
        if (operation.action !== "inbox") throw new Error("unexpected operation");
        calls.push(operation.cursor);
        if (operation.cursor) throw new Error("chi-inbox-invalid-cursor");
        return {
          kind: "inbox",
          actor: context.actor,
          context,
          handoffs: [],
          nextCursor: recovered ? null : "old",
          unreadCount: recovered ? 120 : 60,
          ...(recovered ? {} : { unavailableRepos: ["github:o/b"] }),
        };
      },
    });
    return (
      <InboxCoverageNotice
        unavailableRepos={query.isError ? undefined : query.data?.pages[0]?.unavailableRepos}
      />
    );
  }
  const view = mount(
    <QueryClientProvider client={cache}>
      <Probe />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => expect(query.data?.pages[0]?.unreadCount).toBe(60));
    recovered = true;
    await act(async () => {
      await query.fetchNextPage();
    });
    await vi.waitFor(() => expect(query.data?.pages[0]?.unreadCount).toBe(120));
    expect(calls).toEqual([undefined, "old", undefined]);
    expect(query.data?.pages).toHaveLength(1);
    expect(query.data?.pageParams).toEqual([undefined]);
    expect(query.isError).toBe(false);
    expect(view.container.textContent).toBe("");
  } finally {
    cache.clear();
  }
});

test("cached head is immediate; focus and refresh fetch only page one after scrolling", async () => {
  const cache = new QueryClient();
  const context: ChiMentionContext = {
    actor: "github:alice",
    repo: "*",
    generation: "a".repeat(64),
  };
  const calls: Array<string | undefined> = [];
  let gate: ReturnType<typeof deferred<void>> | undefined;
  let query!: ReturnType<typeof useInboxQuery>;
  function Probe() {
    query = useInboxQuery({
      queryKey: ["swr-test"],
      inbox: true,
      enabled: true,
      context,
      run: async (operation) => {
        if (operation.action !== "inbox") throw new Error("unexpected");
        calls.push(operation.cursor);
        await gate?.promise;
        return {
          kind: "inbox",
          actor: context.actor,
          context,
          handoffs: [],
          nextCursor: operation.cursor ? null : "older",
          unreadCount: 7,
          ...(operation.cursor ? { unavailableRepos: ["github:fixture/older-unavailable"] } : {}),
        };
      },
    });
    return <div>{query.data ? `cached:${query.data.pages.length}` : "waiting"}</div>;
  }
  const view = mount(
    <QueryClientProvider client={cache}>
      <Probe />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => expect(query.data?.pages).toHaveLength(1));
    expect(calls).toEqual([undefined]);
    await act(async () => {
      await query.fetchNextPage();
    });
    expect(query.data?.pages).toHaveLength(2);
    expect(query.unavailableRepos).toEqual(["github:fixture/older-unavailable"]);
    gate = deferred<void>();
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await vi.waitFor(() => expect(calls).toEqual([undefined, "older", undefined]));
    expect(view.container.textContent).toBe("cached:1");
    expect(query.unavailableRepos).toEqual([]);
    await act(async () => {
      gate!.resolve();
    });
    await vi.waitFor(() => expect(query.isFetching).toBe(false));
    expect(query.data?.pages).toHaveLength(1);
    expect(calls).toEqual([undefined, "older", undefined]);
    act(() =>
      view.root.render(
        <QueryClientProvider client={cache}>
          <div />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    gate = deferred<void>();
    const start = performance.now();
    act(() =>
      view.root.render(
        <QueryClientProvider client={cache}>
          <Probe />
        </QueryClientProvider>,
      ),
    );
    expect(view.container.textContent).toBe("cached:1");
    console.info(
      JSON.stringify({
        benchmark: "inbox-cached-remount",
        renderMs: performance.now() - start,
        refreshPending: query.isFetching,
      }),
    );
    await act(async () => {
      gate!.resolve();
    });
  } finally {
    focusManager.setFocused(undefined);
    cache.clear();
  }
});

test("the route immediately shares sidebar transport discovery while verification revalidates", async () => {
  const cache = new QueryClient();
  let gate: ReturnType<typeof deferred<void>> | undefined;
  const verify = async () => {
    await gate?.promise;
    return "verified-host";
  };
  function Probe({ selection = "same" }: { selection?: string }) {
    const query = useFetchQuery(inboxTransportQueryOptions(selection, verify));
    return <div>{query.data ?? "pending"}</div>;
  }
  const sidebar = mount(
    <QueryClientProvider client={cache}>
      <Probe />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => expect(sidebar.container.textContent).toBe("verified-host"));
    gate = deferred<void>();
    const route = mount(
      <QueryClientProvider client={cache}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(route.container.textContent).toBe("verified-host");
    act(() =>
      route.root.render(
        <QueryClientProvider client={cache}>
          <Probe selection="different" />
        </QueryClientProvider>,
      ),
    );
    expect(route.container.textContent).toBe("pending");
    await act(async () => {
      gate!.resolve();
    });
  } finally {
    cache.clear();
  }
});

test("unavailable refresh clears cached head synchronously before the error is observed", async () => {
  const cache = new QueryClient();
  const context: ChiMentionContext = {
    actor: "github:alice",
    repo: "*",
    generation: "a".repeat(64),
  };
  let fail = false;
  let query!: ReturnType<typeof useInboxQuery>;
  function Probe() {
    query = useInboxQuery({
      queryKey: ["fail-test"],
      inbox: true,
      enabled: true,
      context,
      run: async () => {
        if (fail)
          throw new ChiOperationError("chi-mentions-http-503", {
            accessLost: false,
            outcome: "unknown",
          });
        return {
          kind: "inbox",
          actor: context.actor,
          context,
          handoffs: [],
          nextCursor: null,
          unreadCount: 9,
        };
      },
    });
    return <div>{query.data ? "protected" : "empty"}</div>;
  }
  const view = mount(
    <QueryClientProvider client={cache}>
      <Probe />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => expect(view.container.textContent).toBe("protected"));
    fail = true;
    await act(async () => {
      await query.refetch();
    });
    expect(view.container.textContent).toBe("empty");
    expect(cache.getQueryData(["fail-test", "inbox", true])).toBeUndefined();
  } finally {
    cache.clear();
  }
});

test("a cancelled older-page failure cannot erase a newly reauthorized head", async () => {
  const cache = new QueryClient();
  const context: ChiMentionContext = {
    actor: "github:alice",
    repo: "*",
    generation: "a".repeat(64),
  };
  const entered = deferred<void>();
  const release = deferred<void>();
  let query!: ReturnType<typeof useInboxQuery>;
  let reads = 0;
  function Probe() {
    query = useInboxQuery({
      queryKey: ["late-test"],
      inbox: true,
      enabled: true,
      context,
      run: async (operation) => {
        if (operation.action !== "inbox") throw new Error("unexpected");
        if (operation.cursor) {
          entered.resolve();
          await release.promise;
          throw new Error("old failure");
        }
        reads++;
        return {
          kind: "inbox",
          actor: context.actor,
          context,
          handoffs: [],
          nextCursor: "older",
          unreadCount: reads,
        };
      },
    });
    return <div>{query.data?.pages[0]?.unreadCount ?? "empty"}</div>;
  }
  const view = mount(
    <QueryClientProvider client={cache}>
      <Probe />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => expect(view.container.textContent).toBe("1"));
    act(() => {
      void query.fetchNextPage();
    });
    await entered.promise;
    await act(async () => {
      await query.refetch();
    });
    expect(view.container.textContent).toBe("2");
    await act(async () => {
      release.resolve();
    });
    expect(view.container.textContent).toBe("2");
    expect(cache.getQueryData(["late-test", "inbox", true])).toMatchObject({ unreadCount: 2 });
  } finally {
    cache.clear();
  }
});

test("context loss evicts protected SWR state immediately and late responses cannot restore it", async () => {
  const cache = new QueryClient();
  const context: ChiMentionContext = {
    actor: "github:alice",
    repo: "*",
    generation: "a".repeat(64),
  };
  let gate: ReturnType<typeof deferred<void>> | undefined;
  const scope = createMentionScope(
    async (operation) => {
      if (operation.action === "scope") return { kind: "scope", actor: context.actor, context };
      await gate?.promise;
      return {
        kind: "inbox",
        actor: context.actor,
        context,
        handoffs: [],
        nextCursor: null,
        unreadCount: 3,
      };
    },
    () => cache.removeQueries({ queryKey: ["chi-mentions", "host", ""] }),
  );
  await scope.acquire();
  let query!: ReturnType<typeof useInboxQuery>;
  function Probe() {
    const state = React.useSyncExternalStore(scope.subscribe, scope.getState);
    query = useInboxQuery({
      queryKey: mentionQueryKey("host", "", state),
      inbox: true,
      enabled: Boolean(state.context),
      context: state.context ?? undefined,
      run: scope.run,
    });
    return <div>{query.data ? "protected" : "empty"}</div>;
  }
  const view = mount(
    <QueryClientProvider client={cache}>
      <Probe />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() => expect(view.container.textContent).toBe("protected"));
    gate = deferred<void>();
    act(() => {
      void query.refetch();
    });
    act(() => scope.lose());
    expect(view.container.textContent).toBe("empty");
    expect(
      cache
        .getQueryCache()
        .findAll()
        .every((q) => q.state.data === undefined),
    ).toBe(true);
    await act(async () => {
      gate!.resolve();
    });
    expect(view.container.textContent).toBe("empty");
    expect(
      cache
        .getQueryCache()
        .findAll()
        .every((q) => q.state.data === undefined),
    ).toBe(true);
  } finally {
    cache.clear();
  }
});
