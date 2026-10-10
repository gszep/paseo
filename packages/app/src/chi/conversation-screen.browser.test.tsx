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

const fixture = vi.hoisted(() => ({
  supported: true,
  connected: true,
  client: { chiMentions: vi.fn() },
  localCandidate: false,
  navigate: vi.fn(),
}));
vi.mock("expo-router", () => ({
  router: { replace: fixture.navigate, back: fixture.navigate, canGoBack: () => false },
}));
vi.mock("@/components/headers/menu-header", () => ({ MenuHeader: () => null }));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "shared-host" }],
  useHostRuntimeConnectionStatuses: () =>
    new Map([["shared-host", fixture.connected ? "online" : "offline"]]),
  useHostRuntimeClient: (id: string) => (id ? fixture.client : null),
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({
      client: fixture.client,
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
        serverInfo: { features: { chiInboxActivity: true, chiPinnedTimeline: fixture.supported } },
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

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.supported = true;
  fixture.connected = true;
  fixture.localCandidate = false;
  fixture.navigate.mockClear();
  fixture.client = { chiMentions: vi.fn() };
  denied = undefined;
  transient = undefined;
  delayed = undefined;
  currentIdentity = identity;
  currentHandoff = handoff;
  viewedDelay = undefined;
  fixture.client.chiMentions.mockImplementation(
    async ({ operation }: { operation: ChiMentionOperation }) => {
      const context = currentIdentity;
      if (operation.action === "scope") return { kind: "scope", actor: context.actor, context };
      if (denied)
        throw new ChiOperationError(denied, {
          accessLost: true,
          outcome: "unknown",
        });
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
      expect(operation.repo).toBe(pin.repo);
      expect(operation.id).toBe(handoff.id);
      expect(operation.cursor?.startsWith(`${pin.head}:`)).toBe(true);
      const start = Number(operation.cursor!.split(":")[1]);
      const end = Math.min(start + 8, pin.count);
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
        source: handoff.sources[0],
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
        nextCursor: end < pin.count ? `${pin.head}:${end}` : null,
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
    expect(container.textContent).toContain("Read-only shared snapshot");
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
