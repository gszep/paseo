// @vitest-environment jsdom
import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { ChiOperationError, type ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import { queryClient } from "@/data/query-client";
import { loseHostMentionScopes } from "@/chi/use-mention-scope";
import { useAgentAutocomplete } from "./use-agent-autocomplete";
import { Autocomplete } from "@/components/ui/autocomplete";

const fixture = vi.hoisted(() => ({
  client: { chiMentions: vi.fn(), getDirectorySuggestions: vi.fn() },
  connected: true,
  workspace: "workspace",
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
    serverInfo: { features: { chiMentions: true } },
    agents: new Map([
      ["agent", { provider: "opencode", cwd: "/workspace", workspaceId: fixture.workspace }],
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
beforeEach(() => {
  fixture.connected = true;
  fixture.workspace = "workspace";
  fixture.client.chiMentions.mockReset();
  fixture.client.getDirectorySuggestions.mockReset();
  fixture.client.getDirectorySuggestions.mockImplementation(() => new Promise(() => {}));
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
  vi.useRealTimers();
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
