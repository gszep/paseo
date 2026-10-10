import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { AtSign } from "lucide-react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { InboxCoverageNotice } from "./inbox-coverage";
import { inboxTransportQueryOptions, useInboxQuery } from "./inbox-query";
import { useFetchQuery } from "@/data/query";
import {
  ChiOperationError,
  type ChiMentionContext,
  type ChiHandoff,
} from "@getpaseo/protocol/chi-mentions";
import { createMentionScope, mentionQueryKey } from "./mention-context";
import { useInbox, useInboxTransport } from "./use-inbox";
import { queryClient } from "@/data/query-client";
import { SidebarMentionsRow } from "@/components/sidebar/sidebar-mentions-row";
import { ChiInboxScreen } from "./inbox-screen";
import type { InboxListRow } from "./inbox-model";

const host = vi.hoisted(() => ({
  hosts: [{ serverId: "transport-host" }],
  statuses: new Map([["transport-host", "online"]]),
  client: { chiMentions: vi.fn() },
}));
vi.mock("expo-router", () => ({
  router: { push: vi.fn() },
  usePathname: () => "/chi",
  useFocusEffect: () => {},
}));
vi.mock("@/components/headers/menu-header", () => ({ MenuHeader: () => null }));
vi.mock("@/components/ui/form-field", () => ({ FormTextInput: () => null }));
vi.mock("./repository-filter", () => ({
  RepositoryFilter: function RepositoryFilter({ onSelect }: { onSelect(repo: string): void }) {
    const select = React.useCallback(() => onSelect("github:o/a"), [onSelect]);
    return (
      <button type="button" data-testid="choose-test-repo" onClick={select}>
        Choose fixture repository
      </button>
    );
  },
}));
vi.mock("./entry-navigation", () => ({ locateMention: vi.fn(), openMentionTarget: vi.fn() }));
vi.mock("./reply-model", () => ({ openReplyForm: vi.fn() }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => true,
}));
vi.mock("react-native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native")>();
  return {
    ...actual,
    // Exercise the production screen's handlers without FlatList's independent
    // layout-driven onEndReached hiding a broken autoContinue connection.
    FlatList: ({
      onScroll,
      testID,
      data,
      renderItem,
    }: {
      onScroll(event: { nativeEvent: { contentOffset: { y: number } } }): void;
      testID: string;
      data: InboxListRow[];
      renderItem(info: { item: InboxListRow }): React.ReactNode;
    }) => {
      const scroll = React.useCallback(
        (event: React.UIEvent<HTMLDivElement>) =>
          onScroll?.({ nativeEvent: { contentOffset: { y: event.currentTarget.scrollTop } } }),
        [onScroll],
      );
      return (
        <div data-testid={testID} onScroll={scroll}>
          {data.map((item) => (
            <React.Fragment key={item.key}>{renderItem({ item })}</React.Fragment>
          ))}
        </div>
      );
    },
  };
});
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => host.hosts,
  useHostRuntimeConnectionStatuses: () => host.statuses,
  useHostRuntimeClient: (id: string) => (id ? host.client : null),
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({ client: host.client, connectionStatus: "online" }),
  }),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => ({ serverId: "transport-host" }),
}));
vi.mock("@/stores/session-store", () => ({ useSessionStore: () => ["transport-host"] }));
vi.mock("./inbox-identity", async () => {
  const { createInboxAuthority } = await import("./inbox-authority");
  return {
    inboxAuthority: createInboxAuthority({
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    }),
  };
});

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
  queryClient.clear();
});

test.each(["account", "credential", "deployment", "failure"])(
  "real transport verification evicts cached scope before the first observer render: %s",
  async (change) => {
    const original: ChiMentionContext = {
      actor: "github:alice",
      deployment: "synthetic-deployment",
      generation: "a".repeat(64),
      repo: "*",
    };
    const changed = { ...original };
    if (change === "account") changed.actor = "github:bob";
    if (change === "credential") changed.generation = "b".repeat(64);
    if (change === "deployment") changed.deployment = "another-deployment";
    let verifyChanged = false;
    const entered = deferred<void>(),
      release = deferred<void>();
    host.client = {
      chiMentions: vi.fn(async ({ operation }) => {
        if (operation.action === "scope") {
          if (verifyChanged) {
            entered.resolve();
            await release.promise;
            if (change === "failure") throw new Error("verification unavailable");
            return { kind: "scope", actor: changed.actor, context: changed };
          }
          return { kind: "scope", actor: original.actor, context: original };
        }
        return {
          kind: "inbox",
          actor: original.actor,
          context: original,
          handoffs: [],
          nextCursor: null,
          unreadCount: 7,
        };
      }),
    };
    let transport!: ReturnType<typeof useInboxTransport>;
    function Probe() {
      transport = useInboxTransport();
      const inbox = useInbox(transport, { repo: "github:o/a" });
      return <div>{inbox.data ? "protected" : "empty"}</div>;
    }
    const view = mount(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(view.container.textContent).toBe("protected"));
    const oldKey = [...transport.queryKey, "inbox", true, "github:o/a"];
    expect(queryClient.getQueryData(oldKey)).toMatchObject({ unreadCount: 7 });
    // Keep the real scope alive, but remount only transport verification so neither
    // an inbox query nor scope.acquire can accidentally mask missing reconciliation.
    function VerifyOnly() {
      useInboxTransport();
      return null;
    }
    act(() =>
      view.root.render(
        <QueryClientProvider client={queryClient}>
          <div />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    verifyChanged = true;
    const observed: unknown[] = [];
    const unsubscribe = transport.scope.subscribe(() =>
      observed.push(queryClient.getQueryData(oldKey)),
    );
    act(() =>
      view.root.render(
        <QueryClientProvider client={queryClient}>
          <VerifyOnly />
        </QueryClientProvider>,
      ),
    );
    await entered.promise;
    await act(async () => {
      release.resolve();
    });
    await vi.waitFor(() => expect(queryClient.getQueryData(oldKey)).toBeUndefined());
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((value) => value === undefined)).toBe(true);
    act(() =>
      view.root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      ),
    );
    expect(view.container.textContent).toBe("empty");
    unsubscribe();
  },
);

test("the v3 sidebar does not invent a global unread count from a repository inbox", async () => {
  const context: ChiMentionContext = {
    actor: "github:alice",
    deployment: "synthetic-deployment",
    generation: "a".repeat(64),
    repo: "*",
  };
  host.client = {
    chiMentions: vi.fn(async ({ operation }) =>
      operation.action === "scope"
        ? { kind: "scope", actor: context.actor, context }
        : {
            kind: "inbox",
            actor: context.actor,
            context,
            handoffs: [],
            nextCursor: null,
            unreadCount: 0,
            unreadCountIsLowerBound: true,
            unavailableRepos: [],
          },
    ),
  };
  const view = mount(
    <QueryClientProvider client={queryClient}>
      <SidebarMentionsRow />
    </QueryClientProvider>,
  );
  expect(
    view.container.querySelector('[aria-label="0 unread mentions, count incomplete"]'),
  ).toBeNull();
  expect(host.client.chiMentions).not.toHaveBeenCalled();
});

test("empty cursor pages continue automatically, stop on data, and bound repeated or endless cursors", async () => {
  const context: ChiMentionContext = {
    actor: "github:alice",
    generation: "a".repeat(64),
    repo: "*",
  };
  for (const mode of ["data", "cycle", "endless"] as const) {
    const cache = new QueryClient();
    const calls: Array<string | undefined> = [];
    let query!: ReturnType<typeof useInboxQuery>;
    function Probe() {
      query = useInboxQuery({
        queryKey: ["auto", mode],
        inbox: true,
        enabled: true,
        context,
        autoContinue: true,
        run: async (operation) => {
          if (operation.action !== "inbox") throw new Error("unexpected");
          calls.push(operation.cursor);
          const n = Number(operation.cursor ?? 0);
          if (mode === "endless" && n > 10) throw new Error("automatic walk exceeded bound");
          return {
            kind: "inbox",
            actor: context.actor,
            context,
            handoffs:
              mode === "data" && n === 3
                ? [
                    {
                      schemaVersion: 1,
                      id: "visible",
                      repo: "github:o/a",
                      author: "github:bob",
                      recipient: context.actor,
                      text: "Visible mention",
                      sources: [],
                      state: "open",
                      revision: 1,
                      createdAt: "2026-01-01T00:00:00.000Z",
                      updatedAt: "2026-01-01T00:00:00.000Z",
                      events: [],
                    },
                  ]
                : [],
            nextCursor: mode === "cycle" ? "1" : String(n + 1),
            unreadCount: 1,
          };
        },
      });
      return (
        <div>
          {query.data?.pages
            .flatMap((page) => page.handoffs)
            .map((h) => h.text)
            .join("")}
        </div>
      );
    }
    const view = mount(
      <QueryClientProvider client={cache}>
        <Probe />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(calls.length).toBe({ data: 4, cycle: 2, endless: 11 }[mode]));
    await vi.waitFor(() => expect(query.isFetching).toBe(false));
    expect(view.container.textContent).toBe(mode === "data" ? "Visible mention" : "");
    expect(query.hasNextPage).toBe(true);
    act(() => view.root.render(null));
    cache.clear();
  }
});

test("scroll pause suppresses both route and sidebar interval/focus refresh and releases on unmount", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const cache = new QueryClient();
  const context: ChiMentionContext = {
    actor: "github:alice",
    generation: "a".repeat(64),
    repo: "*",
  };
  const calls: Array<string | undefined> = [];
  let query!: ReturnType<typeof useInboxQuery>;
  const run = async (operation: Parameters<ReturnType<typeof createMentionScope>["run"]>[0]) => {
    if (operation.action !== "inbox") throw new Error("unexpected");
    calls.push(operation.cursor);
    return {
      kind: "inbox" as const,
      actor: context.actor,
      context,
      handoffs: [],
      nextCursor: operation.cursor ? null : "older",
      unreadCount: 7,
    };
  };
  function Probe({ paused = false }: { paused?: boolean }) {
    query = useInboxQuery({
      queryKey: ["scroll-pause"],
      inbox: true,
      enabled: true,
      context,
      paused,
      run,
    });
    return null;
  }
  const render = (scrolled: boolean, screen = true) => (
    <QueryClientProvider client={cache}>
      <Probe />
      {screen ? <Probe paused={scrolled} /> : null}
    </QueryClientProvider>
  );
  const view = mount(render(false));
  try {
    await vi.waitFor(() => expect(query.data?.pages).toHaveLength(1));
    await act(async () => {
      await query.fetchNextPage();
    });
    expect(query.data?.pages).toHaveLength(2);
    act(() => view.root.render(render(true)));
    const before = calls.length;
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(60_001);
    });
    expect(calls).toHaveLength(before);
    expect(query.data?.pages).toHaveLength(2);
    act(() => view.root.render(render(false, false)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(before));
    expect(calls.at(-1)).toBeUndefined();
    await vi.waitFor(() => expect(query.data?.pages).toHaveLength(1));
  } finally {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
    cache.clear();
  }
});

test("the default workspace feed loads before a delayed catalog and retries without marking a handoff read", async () => {
  const context: ChiMentionContext = {
    actor: "github:alice",
    deployment: "synthetic-deployment",
    generation: "a".repeat(64),
    evidenceVersion: 3,
    repo: "*",
    defaultRepository: "github:o/a",
  };
  const catalog = deferred<{ kind: "scope"; actor: string; context: ChiMentionContext }>();
  const handoff: ChiHandoff = {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-000000000008",
    repo: "github:o/a",
    author: "github:bob",
    recipient: "github:alice",
    text: "Please review the deployment plan and confirm the next steps before the release. ".repeat(
      8,
    ),
    workspaceName: "Release planning",
    sources: [{ kind: "neutral", id: "source", snapshot: "a".repeat(64), entryId: "entry" }],
    state: "open",
    revision: 1,
    createdAt: "2026-10-08T00:00:00Z",
    updatedAt: "2026-10-08T00:00:00Z",
    events: [],
  };
  let inboxReads = 0;
  let denied = false;
  host.client = {
    chiMentions: vi.fn(async ({ operation }) => {
      if (operation.action === "scope") {
        if (operation.includeRepositories === false)
          return { kind: "scope", actor: context.actor, context };
        return catalog.promise;
      }
      if (operation.action !== "inbox") throw new Error("Unexpected read-marker or mutation");
      expect(operation.repo).toBe("github:o/a");
      inboxReads++;
      if (denied)
        throw new ChiOperationError("chi-mentions-http-403", {
          accessLost: true,
          outcome: "unknown",
        });
      if (inboxReads === 1)
        throw new ChiOperationError("chi-mentions-http-503", {
          accessLost: false,
          outcome: "unknown",
        });
      return {
        kind: "inbox",
        actor: context.actor,
        context,
        handoffs: [handoff],
        nextCursor: null,
        unreadCount: 1,
      };
    }),
  };
  const view = mount(
    <QueryClientProvider client={queryClient}>
      <SidebarMentionsRow />
      <ChiInboxScreen />
    </QueryClientProvider>,
  );
  await vi.waitFor(() => expect(view.container.textContent).toContain("Unable to load mentions"));
  const row = () => view.container.querySelector(`[data-testid="mention-row-${handoff.id}"]`);
  expect(row()).toBeNull();
  const retry = Array.from(view.container.querySelectorAll("button, [role=button]")).find(
    (element) => element.textContent === "Retry",
  )!;
  await act(async () => {
    await userEvent.click(retry);
  });
  await vi.waitFor(() => expect(row()).not.toBeNull());
  expect(row()!.textContent).toContain("Release planning");
  expect(row()!.textContent).toContain(handoff.text);
  expect(
    view.container.querySelector(`[data-testid="mention-unread-${handoff.id}"]`),
  ).not.toBeNull();
  expect(inboxReads).toBe(2);
  expect(
    host.client.chiMentions.mock.calls.filter(([request]) => request.operation.action === "scope"),
  ).toHaveLength(3);
  catalog.resolve({
    kind: "scope",
    actor: context.actor,
    context: { ...context, repositories: ["github:o/a"] },
  });
  expect(handoff.readAt).toBeUndefined();
  denied = true;
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: ["chi-mentions", "transport-host"] });
  });
  await vi.waitFor(() =>
    expect(view.container.textContent).toContain("Mention context unavailable"),
  );
  expect(row()).toBeNull();
  expect(inboxReads).toBe(3);
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === "chi-mentions" && query.state.data !== undefined),
  ).toEqual([]);
});

test("production screen scopes empty-page continuation and scroll pause to the selected repository", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const context: ChiMentionContext = {
    actor: "github:alice",
    deployment: "synthetic-deployment",
    generation: "a".repeat(64),
    repo: "*",
  };
  const calls: Array<string | undefined> = [];
  host.client = {
    chiMentions: vi.fn(async ({ operation }) => {
      if (operation.action === "scope") return { kind: "scope", actor: context.actor, context };
      calls.push(operation.cursor);
      return {
        kind: "inbox",
        actor: context.actor,
        context,
        handoffs: [],
        nextCursor: calls.length < 3 ? String(calls.length) : null,
        unreadCount: 1,
      };
    }),
  };
  const view = mount(
    <QueryClientProvider client={queryClient}>
      <SidebarMentionsRow />
      <ChiInboxScreen />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() =>
      expect(view.container.querySelector('[data-testid="choose-test-repo"]')).not.toBeNull(),
    );
    act(() =>
      (
        view.container.querySelector('[data-testid="choose-test-repo"]') as HTMLButtonElement
      ).click(),
    );
    await vi.waitFor(() => expect(calls).toEqual([undefined, "1", "2"]));
    const list = view.container.querySelector('[data-testid="chi-flat-inbox"]') as HTMLDivElement;
    expect(list).not.toBeNull();
    Object.defineProperty(list, "scrollTop", { value: 0, writable: true, configurable: true });
    act(() => {
      list.scrollTop = 100;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(list.scrollTop).toBe(100);
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(60_001);
    });
    expect(calls).toEqual([undefined, "1", "2"]);
    act(() => {
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls.at(-1)).toBeUndefined();
  } finally {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  }
});

test("compact discussion unmount releases the list pause and returning to its top keeps refresh active", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const context: ChiMentionContext = {
    actor: "github:alice",
    deployment: "synthetic-deployment",
    generation: "a".repeat(64),
    repo: "*",
  };
  const handoff: ChiHandoff = {
    schemaVersion: 1,
    id: "compact",
    repo: "github:o/a",
    author: "github:bob",
    recipient: context.actor,
    text: "Compact fixture",
    sources: [],
    state: "open",
    revision: 1,
    events: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    readAt: "2026-01-01T00:00:00.000Z",
  };
  let reads = 0;
  host.client = {
    chiMentions: vi.fn(async ({ operation }) => {
      if (operation.action === "scope") return { kind: "scope", actor: context.actor, context };
      if (operation.action === "read") throw new Error("synthetic detail unavailable");
      if (operation.action !== "inbox") throw new Error("unexpected operation");
      reads++;
      return {
        kind: "inbox",
        actor: context.actor,
        context,
        handoffs: [handoff],
        nextCursor: null,
        unreadCount: 0,
      };
    }),
  };
  const view = mount(
    <QueryClientProvider client={queryClient}>
      <SidebarMentionsRow />
      <ChiInboxScreen />
    </QueryClientProvider>,
  );
  try {
    await vi.waitFor(() =>
      expect(view.container.querySelector('[data-testid="choose-test-repo"]')).not.toBeNull(),
    );
    act(() =>
      (
        view.container.querySelector('[data-testid="choose-test-repo"]') as HTMLButtonElement
      ).click(),
    );
    await vi.waitFor(() =>
      expect(
        view.container.querySelector('[aria-label="Discuss mention Compact fixture"]'),
      ).not.toBeNull(),
    );
    const list = view.container.querySelector('[data-testid="chi-flat-inbox"]') as HTMLDivElement;
    Object.defineProperty(list, "scrollTop", { value: 100, writable: true, configurable: true });
    act(() => list.dispatchEvent(new Event("scroll", { bubbles: true })));
    const before = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(reads).toBe(before);
    act(() =>
      (
        view.container.querySelector(
          '[aria-label="Discuss mention Compact fixture"]',
        ) as HTMLElement
      ).click(),
    );
    await vi.waitFor(() =>
      expect(view.container.querySelector('[data-testid="chi-flat-inbox"]')).toBeNull(),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    await vi.waitFor(() => expect(reads).toBeGreaterThan(before));
    const back = [...view.container.querySelectorAll('[role="button"]')].find(
      (element) => element.textContent === "Back to mentions",
    ) as HTMLElement;
    expect(back).toBeDefined();
    act(() => back.click());
    const returned = reads;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    await vi.waitFor(() => expect(reads).toBeGreaterThan(returned));
  } finally {
    vi.useRealTimers();
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
    expect(cache.getQueryData(["fail-test", "inbox", true, undefined])).toBeUndefined();
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
    expect(cache.getQueryData(["late-test", "inbox", true, undefined])).toMatchObject({
      unreadCount: 2,
    });
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
