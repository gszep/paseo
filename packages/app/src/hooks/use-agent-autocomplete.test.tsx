// @vitest-environment jsdom
import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { focusManager, onlineManager, QueryClientProvider } from "@tanstack/react-query";
import { ChiOperationError, type ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { queryClient } from "@/data/query-client";
import { loseHostMentionScopes } from "@/chi/use-mention-scope";
import { useAgentAutocomplete } from "./use-agent-autocomplete";
import { Autocomplete } from "@/components/ui/autocomplete";

const fixture = vi.hoisted(() => ({
  client: {
    chiMentions: vi.fn(),
    getDirectorySuggestions: vi.fn(),
    chiSyncStatus: vi.fn(),
  },
  connected: true,
  hasDestination: true,
  mentionsAvailable: true,
  workspace: "workspace",
  native: false,
  appState: "active",
  appStateListeners: new Set<(state: string) => void>(),
}));
vi.mock("react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-native")>()),
  AppState: {
    get currentState() {
      return fixture.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      fixture.appStateListeners.add(listener);
      return { remove: () => fixture.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("@/constants/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/platform")>()),
  get isNative() {
    return fixture.native;
  },
  get isWeb() {
    return !fixture.native;
  },
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => fixture.client,
  useHostRuntimeIsConnected: () => fixture.connected,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: <T,>(select: (state: ReturnType<typeof sessionState>) => T) =>
    select(sessionState()),
}));
function sessionState() {
  const session = {
    serverInfo: { features: { chiMentions: true, chiNative: true } },
    agents: new Map([
      [
        "agent",
        {
          provider: "opencode",
          cwd: "/workspace",
          workspaceId: fixture.workspace,
          labels: {},
        },
      ],
    ]),
  };
  return { sessions: { host: session, other: session } };
}
vi.mock("./use-agent-commands-query", () => ({
  useAgentCommandsQuery: () => ({ commands: [], isLoading: false, isError: false, error: null }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const context: ChiMentionContext = {
  actor: "github:actor",
  repo: "github:fixture/repo",
  generation: "a".repeat(64),
};
function participants(identity = context) {
  return {
    kind: "participants",
    actor: identity.actor,
    context: identity,
    participants: [{ ownerId: "github:sava-the-owl", handle: "sava-the-owl" }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function ignoreInput() {}
function Composer({ text, host }: { text: string; host: string }) {
  const completion = useAgentAutocomplete({
    userInput: text,
    cursorIndex: text.length,
    setUserInput: ignoreInput,
    serverId: host,
    agentId: "agent",
  });
  return completion.isVisible ? (
    <Autocomplete {...completion} onSelect={completion.onSelectOption} />
  ) : null;
}

let root: Root;
let container: HTMLDivElement;
function render(text: string, host = "host") {
  flushSync(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Composer text={text} host={host} />
      </QueryClientProvider>,
    ),
  );
}
function person() {
  return container.querySelector('[data-testid="autocomplete-option-human:github:sava-the-owl"]');
}
function changeAppState(state: "active" | "inactive" | "background") {
  fixture.appState = state;
  for (const listener of fixture.appStateListeners) listener(state);
}
beforeEach(() => {
  fixture.native = false;
  changeAppState("active");
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  fixture.connected = true;
  fixture.hasDestination = true;
  fixture.mentionsAvailable = true;
  fixture.workspace = "workspace";
  fixture.client.chiMentions.mockReset();
  fixture.client.getDirectorySuggestions.mockReset();
  fixture.client.getDirectorySuggestions.mockImplementation(() => new Promise(() => {}));
  fixture.client.chiSyncStatus.mockReset();
  fixture.client.chiSyncStatus.mockImplementation(async () => ({
    outcome: "ready",
    destination: fixture.hasDestination
      ? {
          id: "destination",
          name: "fixture/repo",
          endpoint: "https://chi.invalid",
          audience: "shared",
        }
      : null,
    pending: false,
    error: null,
    mentionsAvailable: fixture.mentionsAvailable,
  }));
  fixture.client.chiMentions.mockImplementation(async ({ operation }) =>
    operation.action === "scope"
      ? { kind: "scope", actor: context.actor, context }
      : participants(),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  loseHostMentionScopes("host");
  loseHostMentionScopes("other");
  queryClient.clear();
  changeAppState("active");
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

it("a local workspace without a sync destination makes no mention RPC and keeps file completion", async () => {
  fixture.hasDestination = false;
  fixture.mentionsAvailable = false;
  fixture.client.getDirectorySuggestions.mockResolvedValue({
    entries: [{ path: "local.txt", name: "local.txt", kind: "file" }],
    error: null,
  });
  render("");
  render("@local");
  await expect
    .poll(() => fixture.client.getDirectorySuggestions.mock.calls.length)
    .toBeGreaterThan(0);
  expect(fixture.client.chiMentions).not.toHaveBeenCalled();
  expect(person()).toBeNull();
  expect(container.textContent).not.toContain("Mention context unavailable");
});

it("prefetches before typing and renders people synchronously while files and background revalidation are pending", async () => {
  render("");
  await expect
    .poll(() =>
      queryClient
        .getQueryCache()
        .getAll()
        .some(
          (query) => query.queryKey.includes("participants") && query.state.status === "success",
        ),
    )
    .toBe(true);
  expect(fixture.client.getDirectorySuggestions).not.toHaveBeenCalled();
  const refreshing = deferred<ReturnType<typeof participants>>();
  fixture.client.chiMentions.mockImplementation(() => refreshing.promise);
  render("@sa");
  expect(person()?.textContent).toContain("sava-the-owl");
  expect(container.textContent).not.toContain("agentAutocomplete.noFiles");
  expect(container.textContent).not.toContain("agentAutocomplete.searchingWorkspace");
  const calls = fixture.client.chiMentions.mock.calls.length;
  render("@sav");
  expect(person()?.textContent).toContain("sava-the-owl");
  expect(fixture.client.chiMentions).toHaveBeenCalledTimes(calls);
  render("");
  render("@sa");
  expect(person()?.textContent).toContain("sava-the-owl");
  refreshing.resolve(participants());
});

it("shows a loading row, not file-empty state, until the people source settles", async () => {
  const loading = deferred<ReturnType<typeof participants>>();
  fixture.client.chiMentions.mockImplementation(({ operation }) =>
    operation.action === "scope"
      ? Promise.resolve({ kind: "scope", actor: context.actor, context })
      : loading.promise,
  );
  fixture.client.getDirectorySuggestions.mockResolvedValue({ entries: [], error: null });
  render("@sa");
  await expect.poll(() => fixture.client.getDirectorySuggestions.mock.calls.length).toBe(1);
  expect(container.textContent).toContain("agentAutocomplete.searchingWorkspace");
  expect(container.textContent).not.toContain("agentAutocomplete.noFiles");
  loading.resolve(participants());
  await expect.poll(() => person()?.textContent).toContain("sava-the-owl");
});

it("keeps empty cached matches in a loading state during background refresh", async () => {
  fixture.client.getDirectorySuggestions.mockResolvedValue({ entries: [], error: null });
  render("@zz");
  await expect.poll(() => container.textContent).toContain("agentAutocomplete.noFiles");
  const refreshing = deferred<ReturnType<typeof participants>>();
  fixture.client.chiMentions.mockImplementation(() => refreshing.promise);
  render("");
  render("@zz");
  await expect.poll(() => container.textContent).toContain("agentAutocomplete.searchingWorkspace");
  expect(container.textContent).not.toContain("agentAutocomplete.noFiles");
  refreshing.resolve(participants());
  await expect.poll(() => container.textContent).toContain("agentAutocomplete.noFiles");
});

it.each(["host", "workspace"])(
  "does not display a cached or delayed directory across a %s switch",
  async (field) => {
    render("@sa");
    await expect.poll(() => person()?.textContent).toContain("sava-the-owl");
    const old = deferred<ReturnType<typeof participants>>();
    fixture.client.chiMentions.mockImplementation(() => old.promise);
    render("");
    render("@sa");
    if (field === "workspace") fixture.workspace = "other-workspace";
    render("@sa", field === "host" ? "other" : "host");
    expect(person()).toBeNull();
    // A current scope acquisition never receives the old protected payload.
    loseHostMentionScopes("host");
    loseHostMentionScopes("other");
    old.resolve(participants());
    await expect
      .poll(
        () =>
          queryClient
            .getQueryCache()
            .getAll()
            .filter(
              (query) =>
                query.queryKey.includes("participants") && query.state.status === "success",
            ).length,
      )
      .toBe(0);
    expect(person()).toBeNull();
  },
);

it("clears visible cached people when background revalidation loses access", async () => {
  render("@sa");
  await expect.poll(() => person()?.textContent).toContain("sava-the-owl");
  fixture.client.chiMentions.mockRejectedValue(
    new ChiOperationError("chi-mentions-http-403", { accessLost: true, outcome: "unknown" }),
  );
  render("");
  render("@sa");
  await expect.poll(() => person()).toBeNull();
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .filter(
        (query) => query.queryKey.includes("participants") && query.state.status === "success",
      ),
  ).toEqual([]);
});

it("discovers newly added people on the background TTL with the popup closed", async () => {
  vi.useFakeTimers();
  render("");
  await vi.advanceTimersByTimeAsync(10);
  expect(fixture.client.chiMentions).toHaveBeenCalledTimes(2);
  fixture.client.chiMentions.mockResolvedValue({
    ...participants(),
    participants: [
      ...participants().participants,
      { ownerId: "github:samantha", handle: "samantha" },
    ],
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fixture.client.chiMentions).toHaveBeenCalledTimes(3);
  render("@sa");
  expect(person()?.textContent).toContain("sava-the-owl");
  expect(
    container.querySelector('[data-testid="autocomplete-option-human:github:samantha"]')
      ?.textContent,
  ).toContain("samantha");
});

it.each(["interval", "focus", "reconnect"])(
  "retries participants on the next %s after a transient failure without losing the verified scope",
  async (trigger) => {
    vi.useFakeTimers();
    render("");
    await vi.advanceTimersByTimeAsync(10);
    expect(fixture.client.chiMentions).toHaveBeenCalledTimes(2);
    fixture.client.chiMentions.mockRejectedValue(new Error("temporary transport failure"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.client.chiMentions).toHaveBeenCalledTimes(3);
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .filter(
          (query) => query.queryKey.includes("participants") && query.state.status === "success",
        ),
    ).toEqual([]);

    fixture.client.chiMentions.mockImplementation(async ({ operation }) =>
      operation.action === "scope"
        ? { kind: "scope", actor: context.actor, context }
        : participants(),
    );
    if (trigger === "focus") {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    }
    if (trigger === "reconnect") {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    }
    await vi.advanceTimersByTimeAsync(trigger === "interval" ? 30_000 : 10);
    expect(fixture.client.chiMentions.mock.calls.map(([input]) => input.operation.action)).toEqual([
      "scope",
      "participants",
      "participants",
      "participants",
    ]);
    render("@sa");
    expect(person()?.textContent).toContain("sava-the-owl");
  },
);

it.each(["inactive", "background"] as const)(
  "pauses native participant polling while %s and refreshes on foreground without reconnecting",
  async (hidden) => {
    vi.useFakeTimers();
    fixture.native = true;
    render("");
    await vi.advanceTimersByTimeAsync(10);
    expect(fixture.client.chiMentions).toHaveBeenCalledTimes(2);
    changeAppState(hidden);
    expect(focusManager.isFocused()).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fixture.client.chiMentions).toHaveBeenCalledTimes(2);
    changeAppState("active");
    await vi.advanceTimersByTimeAsync(10);
    expect(focusManager.isFocused()).toBe(true);
    expect(fixture.connected).toBe(true);
    expect(fixture.client.chiMentions.mock.calls.map(([input]) => input.operation.action)).toEqual([
      "scope",
      "participants",
      "participants",
    ]);
  },
);

it("pauses failed native participant reads in background and retries on foreground without a host transition", async () => {
  vi.useFakeTimers();
  fixture.native = true;
  render("");
  await vi.advanceTimersByTimeAsync(10);
  fixture.client.chiMentions.mockRejectedValue(new Error("temporarily unavailable"));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fixture.client.chiMentions).toHaveBeenCalledTimes(3);
  // Continued failures get one read attempt per interval, not a render/error loop.
  await vi.advanceTimersByTimeAsync(90_000);
  expect(fixture.client.chiMentions).toHaveBeenCalledTimes(6);
  changeAppState("background");
  fixture.client.chiMentions.mockImplementation(async ({ operation }) =>
    operation.action === "scope"
      ? { kind: "scope", actor: context.actor, context }
      : participants(),
  );
  await vi.advanceTimersByTimeAsync(90_000);
  expect(fixture.client.chiMentions).toHaveBeenCalledTimes(6);
  expect(
    queryClient
      .getQueryCache()
      .getAll()
      .filter(
        (query) => query.queryKey.includes("participants") && query.state.status === "success",
      ),
  ).toEqual([]);
  changeAppState("active");
  await vi.advanceTimersByTimeAsync(10);
  expect(fixture.connected).toBe(true);
  expect(
    fixture.client.chiMentions.mock.calls.slice(6).map(([input]) => input.operation.action),
  ).toEqual(["participants"]);
  render("@sa");
  expect(person()?.textContent).toContain("sava-the-owl");
});

it("defers initial native scope acquisition when the composer mounts in background", async () => {
  vi.useFakeTimers();
  fixture.native = true;
  changeAppState("background");
  render("");
  await vi.advanceTimersByTimeAsync(90_000);
  expect(fixture.client.chiMentions).not.toHaveBeenCalled();
  changeAppState("active");
  await vi.advanceTimersByTimeAsync(10);
  expect(fixture.client.chiMentions.mock.calls.map(([input]) => input.operation.action)).toEqual([
    "scope",
    "participants",
  ]);
});
