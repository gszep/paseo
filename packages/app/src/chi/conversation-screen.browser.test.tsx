import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import {
  ChiOperationError,
  type ChiHandoff,
  type ChiMentionContext,
  type ChiMentionOperation,
} from "@getpaseo/protocol/chi-mentions";
import { queryClient } from "@/data/query-client";
import { ChiConversationScreen } from "./conversation-screen";
import { loseHostMentionScopes } from "./use-mention-scope";
import ChiRoute from "@/app/chi";
import { SidebarMentionsRow } from "@/components/sidebar/sidebar-mentions-row";
import { mentionQueryKey } from "./mention-context";
import { classifyMentionFailure } from "../../../server/src/server/chi/mention-failure";

const fixture = vi.hoisted(() => ({
  supported: true,
  currentSupported: false,
  controlSupported: false,
  connected: true,
  client: { chiMentions: vi.fn() },
  localCandidate: false,
  navigate: vi.fn(),
  deploymentInbox: true,
  mixedHosts: false,
  params: { view: "inbox", repo: "", handoff: "", sourceIndex: "0" },
}));
vi.mock("expo-router", () => ({
  router: {
    push: fixture.navigate,
    replace: fixture.navigate,
    back: fixture.navigate,
    canGoBack: () => false,
  },
  useLocalSearchParams: () => fixture.params,
  usePathname: () => "/chi",
  useFocusEffect: () => {},
}));
vi.mock("@/components/host-route-bootstrap-boundary", () => ({
  HostRouteBootstrapBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./continue-screen", () => ({ ChiContinueScreen: () => null }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => window.innerWidth < 500,
}));
vi.mock("@/components/headers/menu-header", () => ({ MenuHeader: () => null }));
const feedClient = {
  async chiMentions(request: { operation: ChiMentionOperation }) {
    const result = await fixture.client.chiMentions(request);
    return {
      ...result,
      context: { ...result.context, generation: "b".repeat(64), deploymentInbox: true },
    };
  },
};
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () =>
    fixture.mixedHosts
      ? [{ serverId: "shared-host" }, { serverId: "feed-host" }]
      : [{ serverId: "shared-host" }],
  useHostRuntimeConnectionStatuses: () =>
    new Map([
      ["shared-host", fixture.connected ? "online" : "offline"],
      ["feed-host", "online"],
    ]),
  useHostRuntimeClient: (id: string) => {
    if (id === "feed-host") return feedClient;
    return id ? fixture.client : null;
  },
  getHostRuntimeStore: () => ({
    getSnapshot: (id: string) => ({
      client: id === "feed-host" ? feedClient : fixture.client,
      connectionStatus: fixture.connected ? "online" : "offline",
    }),
  }),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => ({ serverId: "shared-host" }),
}));
function store() {
  return {
    sessions: {
      "shared-host": {
        serverInfo: {
          features: {
            chiInboxActivity: true,
            chiDeploymentInbox: fixture.deploymentInbox,
            chiPinnedTimeline: fixture.supported,
            chiPinnedCurrent: fixture.currentSupported,
            chiCoDrive: fixture.controlSupported,
          },
        },
        agents: new Map(
          fixture.localCandidate
            ? [
                [
                  "unverified-local",
                  {
                    labels: {
                      "chi.native": JSON.stringify({
                        sourceId: "a".repeat(64),
                        repo: "github:fixture/repo",
                      }),
                    },
                  },
                ],
              ]
            : [],
        ),
      },
      "feed-host": {
        serverInfo: {
          features: { chiInboxActivity: true, chiDeploymentInbox: true, chiPinnedTimeline: true },
        },
        agents: new Map(),
      },
    },
  };
}
vi.mock("@/stores/session-store", () => ({
  useSessionStore: <T,>(select: (value: ReturnType<typeof store>) => T) => select(store()),
}));
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

const identity: ChiMentionContext = {
  actor: "github:reader",
  repo: "*",
  deployment: "https://chi.invalid",
  generation: "a".repeat(64),
  evidenceVersion: 3,
  deploymentInbox: true,
};
const pin = {
  v: 3 as const,
  deployment: "fixture",
  repo: "github:fixture/repo",
  sourceId: "a".repeat(64),
  count: 40,
  head: "b".repeat(64),
};
const ref = { pin, seq: 27 };
const handoff: ChiHandoff = {
  schemaVersion: 1,
  evidenceVersion: 3,
  id: "00000000-0000-4000-8000-000000000143",
  repo: pin.repo,
  author: "github:sender",
  recipient: identity.actor,
  text: "Synthetic mention",
  workspaceName: "Shared workspace",
  sources: [
    { kind: "neutral", id: pin.sourceId, snapshot: pin.head, entryId: "27", appendRef: ref },
  ],
  state: "open",
  revision: 2,
  createdAt: "2020-01-01T00:00:00Z",
  updatedAt: "2020-01-01T00:01:00Z",
  readAt: "2020-01-01T00:01:00Z",
  events: [],
};
let root: Root;
let container: HTMLDivElement;
let denied: string | undefined;
let transient: string | undefined;
let delayed: Promise<void> | undefined;
let currentIdentity: ChiMentionContext;
let currentHandoff: ChiHandoff;
let viewedDelay: Promise<void> | undefined;
let selectedPin = pin;
let currentPin = { ...pin, count: 80, head: "c".repeat(64) };
let currentDelay: Promise<void> | undefined;
let controlDenied: string | undefined;
let inboxRows: ChiHandoff[] = [];
let inboxError: string | undefined;

function assertControlAccess() {
  if (controlDenied)
    throw new ChiOperationError(controlDenied, classifyMentionFailure(new Error(controlDenied)));
}
function assertInboxAvailable() {
  if (inboxError) throw new Error(inboxError);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.supported = true;
  fixture.currentSupported = false;
  fixture.controlSupported = false;
  controlDenied = undefined;
  fixture.connected = true;
  fixture.localCandidate = false;
  fixture.deploymentInbox = true;
  fixture.mixedHosts = false;
  fixture.params = { view: "inbox", repo: "", handoff: "", sourceIndex: "0" };
  fixture.navigate.mockReset();
  fixture.client = { chiMentions: vi.fn() };
  denied = undefined;
  transient = undefined;
  delayed = undefined;
  currentIdentity = identity;
  currentHandoff = handoff;
  viewedDelay = undefined;
  selectedPin = pin;
  currentPin = { ...pin, count: 80, head: "c".repeat(64) };
  currentDelay = undefined;
  inboxRows = [];
  inboxError = undefined;
  fixture.client.chiMentions.mockImplementation(
    async ({ operation }: { operation: ChiMentionOperation }) => {
      const context = currentIdentity;
      if (operation.action === "scope") return { kind: "scope", actor: context.actor, context };
      if (denied)
        throw new ChiOperationError(denied, {
          accessLost: true,
          outcome: "unknown",
        });
      if (operation.action === "control") {
        assertControlAccess();
        return {
          kind: "control",
          actor: context.actor,
          context,
          view: {
            sourceId: pin.sourceId,
            pin: currentPin,
            ownerId: "github:sender",
            ready: true,
            surface: "send-text",
            operation: null,
            control: {
              v: 3,
              generation: 1,
              active: true,
              recipient: context.actor,
              contextDigest: "e".repeat(64),
              readyUntil: Date.now() + 15000,
              readyPin: currentPin,
              pending: null,
              executor: {
                instanceId: "fixture-host:opencode",
                nativeSessionId: "ses_fixture",
                bindingRevision: 1,
                host: "Fixture original host",
                provider: "opencode",
                modelProvider: "fixture",
                modelId: "fixture-model",
                modelVariant: null,
                policyDigest: "f".repeat(64),
                account: "owner-host-configured",
              },
            },
          },
        };
      }
      if (operation.action === "inbox") {
        expect(operation.repo).toBeUndefined();
        assertInboxAvailable();
        return {
          kind: "inbox",
          actor: context.actor,
          context,
          handoffs: inboxRows,
          nextCursor: null,
          unreadCount: inboxRows.filter((row) => !row.readAt).length,
          unreadCountIsLowerBound: false,
        };
      }
      if (operation.action === "read")
        return { kind: "handoff", actor: context.actor, context, handoff: currentHandoff };
      if (operation.action === "viewed") {
        const selected = currentHandoff;
        if (viewedDelay) await viewedDelay;
        currentHandoff = {
          ...selected,
          revision: selected.revision + 1,
          readAt: "2020-01-01T00:02:00Z",
        };
        return { kind: "handoff", actor: context.actor, context, handoff: currentHandoff };
      }
      if (operation.action !== "context")
        throw new Error(`Unexpected mutation or native operation: ${operation.action}`);
      expect(operation.repo).toBe(selectedPin.repo);
      expect(operation.id).toBe(handoff.id);
      const viewPin = operation.latest ? currentPin : (operation.pin ?? selectedPin);
      const cursor = operation.latest
        ? `${viewPin.head}:${Math.max(0, viewPin.count - 8)}`
        : operation.cursor!;
      expect(cursor.startsWith(`${viewPin.head}:`)).toBe(true);
      const start = Number(cursor.split(":")[1]);
      const end = Math.min(start + 8, viewPin.count);
      if (operation.latest && currentDelay) await currentDelay;
      if (delayed) await delayed;
      if (transient)
        throw new ChiOperationError(transient, {
          accessLost: false,
          outcome: "unknown",
        });
      return {
        kind: "context",
        actor: context.actor,
        context,
        source: currentHandoff.sources[0],
        ...(operation.latest || operation.pin ? { viewPin } : {}),
        ...(operation.latest ? { bindingRevision: 7 } : {}),
        entries: Array.from({ length: end - start }, (_, n) => {
          const seq = start + n;
          return {
            nativeId: `msg_${seq}`,
            seq,
            type: "user",
            timestamp: "2020-01-01T00:00:00Z",
            items: [
              {
                type: "user_message",
                messageId: `msg_${seq}`,
                text:
                  seq === 27
                    ? "Exact target mention"
                    : `Earlier shared message ${seq}. `.repeat(30),
              },
            ],
          };
        }),
        nextCursor: end < viewPin.count ? `${viewPin.head}:${end}` : null,
      };
    },
  );
  container = document.createElement("div");
  container.style.cssText = "display:flex;width:100%;height:750px;position:relative";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  loseHostMentionScopes("shared-host");
  loseHostMentionScopes("feed-host");
  queryClient.clear();
  focusManager.setFocused(undefined);
  container.remove();
});
function render() {
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ChiConversationScreen repo={pin.repo} handoffId={handoff.id} sourceIndex={0} />
      </QueryClientProvider>,
    ),
  );
}
function target() {
  return container.querySelector<HTMLElement>('[data-testid="referenced-history-item"]');
}

test.each([390, 1280])(
  "explicit current tail preserves the mention and never executes at %spx",
  async (width) => {
    fixture.currentSupported = true;
    await page.viewport(width, 900);
    render();
    await expect.element(page.getByText("Exact target mention", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View current shared tail" }).click();
    await expect.element(page.getByTestId("shared-current-pin")).toHaveTextContent("80 entries");
    await expect
      .element(page.getByTestId("shared-conversation-pin"))
      .toHaveTextContent("40 entries");
    expect(
      fixture.client.chiMentions.mock.calls.some(
        ([input]) =>
          input.operation.action === "context" && input.operation.pin?.head === currentPin.head,
      ),
    ).toBe(true);
    await expect
      .poll(() => {
        const last = [...container.querySelectorAll<HTMLElement>("*")].find(
          (element) =>
            element.children.length === 0 &&
            element.textContent?.trim() === "Earlier shared message 79. ".repeat(30).trim(),
        );
        const viewport = container.querySelector('[data-testid="read-only-stream"]');
        if (!last || !viewport) return false;
        const row = last.getBoundingClientRect(),
          bounds = viewport.getBoundingClientRect();
        return row.bottom > bounds.top && row.top < bounds.bottom;
      })
      .toBe(true);
    await page.screenshot({ path: `../../.vitest-screenshots/current-tail-${width}.png` });
    currentPin = { ...currentPin, count: 81, head: "d".repeat(64) };
    await expect.element(page.getByTestId("shared-current-pin")).toHaveTextContent("80 entries");
    await page.getByRole("button", { name: "Jump to mention" }).click();
    await expect.element(page.getByText("Exact target mention", { exact: true })).toBeVisible();
    expect(container.querySelector('[data-testid="shared-current-pin"]')).toBeNull();
    expect(
      fixture.client.chiMentions.mock.calls.every(([input]) =>
        ["scope", "read", "context"].includes(input.operation.action),
      ),
    ).toBe(true);
  },
);

test("a late current-head response cannot override an explicit return to the mention", async () => {
  fixture.currentSupported = true;
  render();
  await expect.element(page.getByText("Exact target mention", { exact: true })).toBeVisible();
  let release!: () => void;
  currentDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.getByRole("button", { name: "View current shared tail" }).click();
  await page.getByRole("button", { name: "Jump to mention" }).click();
  await act(async () => {
    release();
    await currentDelay;
  });
  expect(container.querySelector('[data-testid="shared-current-pin"]')).toBeNull();
  await expect.element(page.getByText("Exact target mention", { exact: true })).toBeVisible();
});

function renderRoute() {
  root.render(
    <QueryClientProvider client={queryClient}>
      <ChiRoute />
    </QueryClientProvider>,
  );
}

test("revocation clears the selected current tail and ignores a late head refresh", async () => {
  fixture.currentSupported = true;
  render();
  await expect.element(page.getByText("Exact target mention", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View current shared tail" }).click();
  await expect.element(page.getByTestId("shared-current-pin")).toHaveTextContent("80 entries");
  let release!: () => void;
  currentDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.getByRole("button", { name: "View current shared tail" }).click();
  denied = "chi-mentions-http-404";
  await act(async () => {
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes("handoff") });
  });
  expect(container.querySelector('[data-testid="shared-current-pin"]')).toBeNull();
  expect(protectedData()).toEqual([]);
  await act(async () => {
    release();
    await currentDelay;
  });
  expect(container.querySelector('[data-testid="shared-current-pin"]')).toBeNull();
  expect(protectedData()).toEqual([]);
});

test.each([401, 403, 404])(
  "co-drive HTTP %s clears the enclosing conversation/cache and fences a late head response",
  async (status) => {
    localStorage.clear();
    fixture.currentSupported = true;
    fixture.controlSupported = true;
    currentIdentity = { ...identity, coDrive: true };
    render();
    await expect.element(page.getByText("Exact target mention", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "View current shared tail" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Shared session message" }))
      .toBeVisible();
    expect(protectedData().length).toBeGreaterThan(0);
    let release!: () => void;
    currentDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.getByRole("button", { name: "View current shared tail" }).click();
    controlDenied = `chi-control-http-${status}`;
    await userEvent.fill(
      page.getByRole("textbox", { name: "Shared session message" }),
      "synthetic denied send",
    );
    await page.getByRole("button", { name: "Send to shared session", exact: true }).click();
    await expect.poll(protectedData).toEqual([]);
    expect(container.querySelector('[data-testid="read-only-stream"]')).toBeNull();
    await act(async () => {
      release();
      await currentDelay;
    });
    expect(protectedData()).toEqual([]);
    expect(container.querySelector('[data-testid="shared-current-pin"]')).toBeNull();
    expect(container.querySelector('[data-testid="read-only-stream"]')).toBeNull();
  },
);

test.each([390, 1280])(
  "sidebar to cross-repository mentions to exact conversation and back at %spx",
  async (width) => {
    await page.viewport(width, 900);
    expect(window.innerWidth).toBe(width);
    const secondPin = { ...pin, repo: "github:fixture/second", head: "c".repeat(64) };
    const second: ChiHandoff = {
      ...handoff,
      repo: secondPin.repo,
      text: "Second repository mention",
      workspaceName: "Second workspace",
      sources: [
        {
          kind: "neutral",
          id: secondPin.sourceId,
          snapshot: secondPin.head,
          entryId: "27",
          appendRef: { pin: secondPin, seq: 27 },
        },
      ],
    };
    inboxRows = [handoff, second];
    fixture.navigate.mockImplementation(({ params }) => {
      fixture.params = params;
      if (params.view === "conversation") {
        currentHandoff = inboxRows.find(
          (row) => row.repo === params.repo && row.id === params.handoff,
        )!;
        selectedPin = params.repo === pin.repo ? pin : secondPin;
      }
      renderRoute();
    });
    act(() => root.render(<SidebarMentionsRow />));
    await click("Mentions");
    await expect
      .poll(() => container.querySelectorAll('[data-testid^="mention-row-"]').length)
      .toBe(2);
    await page.screenshot({ path: `../../.vitest-screenshots/flat-mentions-${width}.png` });
    for (const row of inboxRows) {
      await expect
        .poll(() => container.querySelectorAll('[data-testid^="mention-row-"]').length)
        .toBe(2);
      expect(container.textContent).not.toContain("Choose repository");
      expect(container.textContent).not.toContain("Choose a repository");
      const open = container.querySelector<HTMLElement>(`[aria-label="Open mention ${row.text}"]`)!;
      await act(async () => {
        await userEvent.click(open);
      });
      expect(fixture.navigate).toHaveBeenLastCalledWith({
        pathname: "/chi",
        params: { view: "conversation", repo: row.repo, handoff: row.id, sourceIndex: "0" },
      });
      await expect.poll(() => target()?.textContent).toContain("Exact target mention");
      await expect
        .poll(() => {
          const rect = target()!.getBoundingClientRect();
          const viewport = container
            .querySelector('[data-testid="agent-chat-scroll"]')!
            .getBoundingClientRect();
          return rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1;
        })
        .toBe(true);
      expect(container.textContent).toContain("Original mention snapshot (read-only)");
      await page.screenshot({
        path: `../../.vitest-screenshots/flat-mentions-conversation-${width}-${row.repo.split("/").at(-1)}.png`,
      });
      await click("Back to mentions");
    }
    await expect
      .poll(() => container.querySelectorAll('[data-testid^="mention-row-"]').length)
      .toBe(2);
    expect(new Set(fixture.client.chiMentions.mock.calls.map(([r]) => r.operation.action))).toEqual(
      new Set(["scope", "inbox", "read", "context"]),
    );
    expect(
      fixture.client.chiMentions.mock.calls
        .filter(([r]) => r.operation.action === "scope")
        .every(([r]) => r.operation.includeRepositories === false),
    ).toBe(true);
  },
);

test.each(["old-host", "old-backend", "unready"] as const)(
  "flat route fails explicitly without repository fallback: %s",
  async (mode) => {
    fixture.deploymentInbox = mode !== "old-host";
    currentIdentity = { ...identity, deploymentInbox: mode !== "old-backend" };
    if (mode === "unready") inboxError = "chi-mentions-http-503-deployment-inbox-not-ready";
    act(renderRoute);
    const expected = {
      "old-host": "Connect or update a host",
      "old-backend": "backend update",
      unready: "complete the inbox migration",
    };
    await expect.poll(() => container.textContent).toContain(expected[mode]);
    expect(container.querySelector('[data-testid="inbox-repo-filter-trigger"]')).toBeNull();
    expect(container.textContent).not.toContain("Choose a repository");
    expect(
      fixture.client.chiMentions.mock.calls.filter(([r]) => r.operation.action === "inbox"),
    ).toHaveLength(mode === "unready" ? 1 : 0);
  },
);

test("first-view through a preferred older host invalidates only matching deployment feeds on the newer host", async () => {
  fixture.mixedHosts = true;
  fixture.deploymentInbox = false;
  currentIdentity = { ...identity, deploymentInbox: false };
  currentHandoff = { ...handoff, readAt: undefined };
  inboxRows = [currentHandoff];
  fixture.navigate.mockImplementation(({ params }) => {
    fixture.params = params;
    renderRoute();
  });
  act(renderRoute);
  await expect
    .poll(() => container.querySelectorAll('[data-testid^="mention-row-"]').length)
    .toBe(1);
  const feed = queryClient
    .getQueryCache()
    .getAll()
    .find((query) => query.queryKey.includes("inbox") && !query.queryKey.includes("older"))!;
  expect(feed.queryKey[1]).toBe("feed-host");
  expect(feed.queryKey[5]).toBe("b".repeat(64));
  const unrelated = [
    [
      ...mentionQueryKey("other-actor", "", {
        error: null,
        generation: 1,
        context: { ...identity, actor: "github:other" },
      }),
      "inbox",
      true,
      undefined,
    ],
    [
      ...mentionQueryKey("other-deployment", "", {
        error: null,
        generation: 1,
        context: { ...identity, deployment: "https://other.invalid" },
      }),
      "inbox",
      true,
      undefined,
    ],
    [
      ...mentionQueryKey("workspace", "local", { generation: 1, context: identity, error: null }),
      "inbox",
      true,
      undefined,
    ],
    [
      ...mentionQueryKey("scoped", "", { generation: 1, context: identity, error: null }),
      "inbox",
      true,
      pin.repo,
    ],
  ];
  for (const key of unrelated) queryClient.setQueryData(key, { protected: "unrelated" });
  expect(feed.queryKey.at(-1)).toBeUndefined();
  expect(
    fixture.client.chiMentions.mock.calls.filter(([r]) => r.operation.action === "viewed"),
  ).toHaveLength(0);
  await act(async () => {
    await userEvent.click(
      container.querySelector<HTMLElement>(`[aria-label="Open mention ${handoff.text}"]`)!,
    );
  });
  await expect.poll(() => feed.state.isInvalidated).toBe(true);
  const viewed = fixture.client.chiMentions.mock.calls.filter(
    ([r]) => r.operation.action === "viewed",
  );
  expect(viewed).toHaveLength(1);
  expect(viewed[0]![0].operation).toEqual({
    action: "viewed",
    repo: handoff.repo,
    id: handoff.id,
    revision: handoff.revision,
  });
  expect(viewed[0]![0].expectedContext.generation).toBe(identity.generation);
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .find((query) => query.queryKey.includes("handoff"))?.queryKey[1],
  ).toBe("shared-host");
  for (const key of unrelated) {
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(key)).toEqual({ protected: "unrelated" });
  }
});
function protectedData() {
  return queryClient
    .getQueryCache()
    .getAll()
    .filter((q) => q.queryKey.includes("conversation") && q.state.data !== undefined);
}
async function click(label: string) {
  const element = Array.from(
    container.querySelectorAll<HTMLElement>('[role="button"],button'),
  ).find((e) => e.textContent === label);
  if (!element) throw new Error(`Missing ${label}`);
  await act(async () => {
    await userEvent.click(element);
  });
}

test.each([390, 1280])(
  "production shared screen at %spx shows/scrolls to the exact native message without a local repository",
  async (width) => {
    await page.viewport(width, 900);
    render();
    await expect.poll(() => target()?.textContent).toContain("Exact target mention");
    await expect
      .poll(() => {
        const row = target()!.getBoundingClientRect();
        const viewport = container
          .querySelector('[data-testid="agent-chat-scroll"]')!
          .getBoundingClientRect();
        return row.top >= viewport.top - 1 && row.bottom <= viewport.bottom + 1;
      })
      .toBe(true);
    expect(target()?.querySelector('[data-testid="user-message-author"]')?.textContent).toBe(
      "User",
    );
    expect(container.textContent).toContain("Shared workspace");
    expect(container.textContent).toContain("Mention from @sender");
    expect(container.textContent).toContain("Original mention snapshot (read-only)");
    expect(
      container.querySelectorAll("textarea,input,[data-testid*=rewind],[data-testid*=composer]")
        .length,
    ).toBe(0);
    expect(
      fixture.client.chiMentions.mock.calls.find(([r]) => r.operation.action === "context")?.[0]
        .operation.cursor,
    ).toBe(`${pin.head}:24`);
    expect(new Set(fixture.client.chiMentions.mock.calls.map(([r]) => r.operation.action))).toEqual(
      new Set(["scope", "read", "context"]),
    );
    expect(fixture.navigate).not.toHaveBeenCalled();
  },
);

test("a matching local label is not used as native-session proof", async () => {
  fixture.localCandidate = true;
  render();
  await expect.poll(() => target()?.textContent).toContain("Exact target mention");
  expect(fixture.navigate).not.toHaveBeenCalled();
  expect(new Set(fixture.client.chiMentions.mock.calls.map(([r]) => r.operation.action))).toEqual(
    new Set(["scope", "read", "context"]),
  );
});

test("new client on an older host gates the shared reader without issuing page/native calls", async () => {
  fixture.supported = false;
  render();
  await expect.poll(() => container.textContent).toContain("Update this host");
  expect(fixture.client.chiMentions.mock.calls.every(([r]) => r.operation.action === "scope")).toBe(
    true,
  );
  expect(target()).toBeNull();
});

test("an unsupported historical source stays on an explicit error rather than opening local history", async () => {
  currentHandoff = { ...handoff, sources: [{ kind: "artifact", id: "historical-artifact" }] };
  render();
  await expect.poll(() => container.textContent).toContain("No local history was substituted");
  expect(target()).toBeNull();
  expect(
    fixture.client.chiMentions.mock.calls.every(([r]) =>
      ["scope", "read"].includes(r.operation.action),
    ),
  ).toBe(true);
  expect(fixture.navigate).not.toHaveBeenCalled();
});

test.each(["chi-mentions-http-503", "chi-operation-timeout"])(
  "%s keeps a route-local Retry, with no stale protected page or local fallback",
  async (code) => {
    transient = code;
    render();
    await expect.poll(() => container.textContent).toContain("Retry conversation");
    expect(target()).toBeNull();
    expect(protectedData()).toEqual([]);
    transient = undefined;
    await click("Retry conversation");
    await expect.poll(() => target()?.textContent).toContain("Exact target mention");
    expect(fixture.navigate).not.toHaveBeenCalled();
  },
);

test.each(["denial", "deleted", "credential", "deployment", "account"])(
  "%s clears visible/cached source and a late page cannot restore it",
  async (change) => {
    render();
    await expect.poll(() => target()?.textContent).toContain("Exact target mention");
    let release!: () => void;
    delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    await click("Load newer history");
    await expect
      .poll(() =>
        fixture.client.chiMentions.mock.calls.some(
          ([r]) => r.operation.action === "context" && r.operation.cursor === `${pin.head}:32`,
        ),
      )
      .toBe(true);
    if (change === "denial") denied = "chi-mentions-http-403";
    else if (change === "deleted") denied = "chi-mentions-http-404";
    else {
      currentIdentity = { ...identity, generation: "c".repeat(64) };
      if (change === "deployment") currentIdentity.deployment = "https://other.invalid";
      if (change === "account") currentIdentity.actor = "github:other";
    }
    await act(async () => {
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey.includes("handoff") });
    });
    await expect.poll(() => target()).toBeNull();
    expect(protectedData()).toEqual([]);
    await act(async () => {
      release();
    });
    await expect.poll(() => protectedData()).toEqual([]);
    expect(target()).toBeNull();
    expect(fixture.navigate).not.toHaveBeenCalled();
  },
);

test("disconnect invalidates the protected window without native/local fallback", async () => {
  render();
  await expect.poll(() => target()?.textContent).toContain("Exact target mention");
  act(() => {
    fixture.connected = false;
    loseHostMentionScopes("shared-host");
  });
  render();
  await expect.poll(() => target()).toBeNull();
  expect(protectedData()).toEqual([]);
  expect(fixture.navigate).not.toHaveBeenCalled();
});

test("leaving the conversation cancels a pending page and discards its late result", async () => {
  let release!: () => void;
  delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  render();
  await expect
    .poll(() =>
      fixture.client.chiMentions.mock.calls.some(([r]) => r.operation.action === "context"),
    )
    .toBe(true);
  act(() => root.render(null));
  await act(async () => {
    release();
  });
  await expect.poll(() => protectedData()).toEqual([]);
  expect(container.textContent).toBe("");
  expect(fixture.navigate).not.toHaveBeenCalled();
});

test.each(["recipient", "author", "already-read"])(
  "preserves first-view marker semantics for %s without another mutation",
  async (viewer) => {
    currentHandoff = {
      ...handoff,
      author: viewer === "author" ? identity.actor : handoff.author,
      recipient: viewer === "author" ? "github:someone-else" : identity.actor,
      readAt: viewer === "already-read" ? handoff.readAt : undefined,
    };
    render();
    await expect.poll(() => target()?.textContent).toContain("Exact target mention");
    expect(
      fixture.client.chiMentions.mock.calls.filter(([r]) => r.operation.action === "viewed"),
    ).toHaveLength(viewer === "recipient" ? 1 : 0);
    expect(
      fixture.client.chiMentions.mock.calls.every(([r]) =>
        ["scope", "read", "context", "viewed"].includes(r.operation.action),
      ),
    ).toBe(true);
  },
);

test("a late first-view reply cannot restore a cleared handoff or remain in mutation data", async () => {
  currentHandoff = { ...handoff, readAt: undefined };
  let release!: () => void;
  viewedDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  render();
  await expect
    .poll(() =>
      fixture.client.chiMentions.mock.calls.some(([r]) => r.operation.action === "viewed"),
    )
    .toBe(true);
  act(() => {
    denied = "chi-mentions-http-403";
    loseHostMentionScopes("shared-host");
  });
  await act(async () => {
    release();
  });
  await expect.poll(() => target()).toBeNull();
  expect(protectedData()).toEqual([]);
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .filter((q) => q.queryKey.includes("handoff") && q.state.data !== undefined),
  ).toEqual([]);
  expect(
    queryClient
      .getMutationCache()
      .getAll()
      .every((mutation) => mutation.state.data === undefined),
  ).toBe(true);
});
