import React, { useCallback, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "@vitest/browser/context";
import { Autocomplete, type AutocompleteOption } from "./autocomplete";
import { useAutocomplete } from "@/hooks/use-autocomplete";
import {
  buildMentionAutocompleteOptions,
  type DirectorySuggestionEntry,
} from "@/composer/autocomplete";
import { selectedRecipients, type SelectedMention } from "@/chi/mention-selection";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/data/query-client";
import { useAgentAutocomplete } from "@/hooks/use-agent-autocomplete";
import { loseHostMentionScopes } from "@/chi/use-mention-scope";

const host = vi.hoisted(() => ({
  client: { chiSyncStatus: vi.fn(), chiMentions: vi.fn(), getDirectorySuggestions: vi.fn() },
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => host.client,
  useHostRuntimeIsConnected: () => true,
}));
const session = {
  sessions: {
    host: {
      serverInfo: { features: { chiAppendV3: true } },
      agents: new Map([
        ["healthy", { provider: "opencode", cwd: "/repo", workspaceId: "workspace", labels: {} }],
      ]),
    },
  },
};
vi.mock("@/stores/session-store", () => ({
  useSessionStore: <T,>(select: (state: typeof session) => T) => select(session),
}));
vi.mock("@/hooks/use-agent-commands-query", () => ({
  useAgentCommandsQuery: () => ({ commands: [], isLoading: false, isError: false, error: null }),
}));

function DirectoryComposer() {
  const [text, setText] = useState("");
  const completion = useAgentAutocomplete({
    userInput: text,
    cursorIndex: text.length,
    setUserInput: setText,
    serverId: "host",
    agentId: "healthy",
  });
  const change = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setText(event.target.value);
  }, []);
  const { onKeyPress } = completion;
  const keyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      onKeyPress({
        key: event.key,
        preventDefault: () => event.preventDefault(),
        input: {
          text: event.currentTarget.value,
          selection: {
            start: event.currentTarget.selectionStart ?? 0,
            end: event.currentTarget.selectionEnd ?? 0,
          },
        },
      });
    },
    [onKeyPress],
  );
  return (
    <div style={harnessStyle}>
      {completion.isVisible ? (
        <Autocomplete {...completion} onSelect={completion.onSelectOption} />
      ) : null}
      <input aria-label="Draft only" value={text} onChange={change} onKeyDown={keyDown} />
    </div>
  );
}

const files: DirectorySuggestionEntry[] = Array.from({ length: 20 }, (_, index) => ({
  path: `file-${index}.ts`,
  kind: "file",
}));
const participants: SelectedMention[] = Array.from({ length: 8 }, (_, index) => ({
  ownerId: `github:person-${index}`,
  handle: `person-${index}`,
  context: { actor: "github:actor", repo: "github:fixture/repo", generation: "a".repeat(64) },
}));

interface HarnessProps {
  people: SelectedMention[];
  entries: DirectorySuggestionEntry[];
  onSelect: (id: string) => void;
  isLoading?: boolean;
}

const harnessStyle = { width: 360 };

function recordSelections() {
  const accepted: string[] = [];
  return { accepted, onSelect: (id: string) => accepted.push(id) };
}

function ignoreSelection() {}

function Harness({ people, entries, onSelect, isLoading }: HarnessProps) {
  const selectOption = useCallback((option: AutocompleteOption) => onSelect(option.id), [onSelect]);
  const options = buildMentionAutocompleteOptions({
    text: "@",
    mention: { start: 0, end: 1, query: "" },
    participants: people,
    files: entries,
  });
  const completion = useAutocomplete({
    isVisible: true,
    options,
    query: "",
    onSelectOption: selectOption,
  });
  return (
    <div style={harnessStyle}>
      <Autocomplete
        options={options}
        selectedIndex={completion.selectedIndex}
        onSelect={selectOption}
        isLoading={isLoading}
      />
      <input aria-label="Completion input" onKeyDown={completion.onKeyPress} />
    </div>
  );
}

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  loseHostMentionScopes("host");
  queryClient.clear();
  vi.clearAllMocks();
});

it.each(["@Ste", "@SteffenPL"])(
  "Tab selects Steffen from %s despite a sibling session's capture error",
  async (text) => {
    const context = {
      actor: "github:actor",
      repo: "github:fixture/repo",
      generation: "a".repeat(64),
      evidenceVersion: 3 as const,
    };
    host.client.chiSyncStatus.mockResolvedValue({
      outcome: "ready",
      destination: {
        id: "primary",
        name: "Primary",
        endpoint: "https://chi.invalid",
        audience: "shared",
      },
      pending: false,
      error: "capture-local-secret-rejected",
      mentionsAvailable: true,
    });
    host.client.chiMentions.mockImplementation(async ({ operation }) =>
      operation.action === "scope"
        ? { kind: "scope", actor: context.actor, context }
        : {
            kind: "participants",
            actor: context.actor,
            context,
            participants: [{ ownerId: "github:steffenpl", handle: "SteffenPL" }],
          },
    );
    host.client.getDirectorySuggestions.mockResolvedValue({ entries: [], error: null });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <DirectoryComposer />
        </QueryClientProvider>,
      ),
    );
    const input = container.querySelector("input")!;
    await userEvent.fill(input, text);
    await expect
      .poll(
        () =>
          container.querySelector('[data-testid="autocomplete-option-human:github:steffenpl"]')
            ?.textContent,
      )
      .toContain("@SteffenPL");
    expect(container.textContent).not.toContain("No files or directories found");
    await userEvent.keyboard("{Tab}");
    expect(input.value).toBe("@SteffenPL ");
    expect(selectedRecipients("host", "healthy", input.value)).toEqual(["github:steffenpl"]);
    expect(
      new Set(host.client.chiMentions.mock.calls.map(([request]) => request.operation.action)),
    ).toEqual(new Set(["scope", "participants"]));
  },
);

async function settleLayout() {
  // RN web measures on animation frames; include the subsequent scroll event.
  for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
}

function selectedGeometry() {
  const row = container.querySelector('[aria-selected="true"]');
  const scroll = container.querySelector('[data-testid="autocomplete-scroll"]');
  if (!row || !scroll) throw new Error("Missing autocomplete geometry");
  const bounds = row.getBoundingClientRect();
  const viewport = scroll.getBoundingClientRect();
  return {
    id: row.getAttribute("data-testid"),
    visible: bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1,
  };
}

it.each(["Tab", "Enter"])(
  "keeps the arrow-selected file visible and accepts it with %s after sources grow/reorder",
  async (key) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const { accepted, onSelect } = recordSelections();
    flushSync(() => root.render(<Harness people={[]} entries={files} onSelect={onSelect} />));
    await settleLayout();
    const input = container.querySelector("input")!;
    await userEvent.click(input);
    // The default is row 19. Navigate to row 5 before the people source arrives.
    for (let step = 0; step < 14; step++) {
      await userEvent.keyboard("{ArrowUp}");
    }
    await settleLayout();
    const expected = { id: "autocomplete-option-file:file-14.ts", visible: true };
    expect(selectedGeometry()).toEqual(expected);
    flushSync(() =>
      root.render(<Harness people={participants} entries={files} onSelect={onSelect} />),
    );
    await settleLayout();
    expect(selectedGeometry()).toEqual(expected);
    const moreFiles: DirectorySuggestionEntry[] = [
      ...files,
      ...files.map((file) => ({ ...file, path: `new-${file.path}` })),
    ];
    flushSync(() =>
      root.render(<Harness people={participants} entries={moreFiles} onSelect={onSelect} />),
    );
    await settleLayout();
    expect(selectedGeometry()).toEqual(expected);
    await userEvent.keyboard(`{${key}}`);
    expect(accepted).toEqual(["file:file-14.ts"]);
  },
);

it("keeps the default nearest the input visible when people arrive without arrow navigation", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root.render(<Harness people={[]} entries={files} onSelect={ignoreSelection} />));
  await settleLayout();
  expect(selectedGeometry()).toEqual({ id: "autocomplete-option-file:file-0.ts", visible: true });
  flushSync(() =>
    root.render(<Harness people={participants} entries={files} onSelect={ignoreSelection} />),
  );
  await settleLayout();
  expect(selectedGeometry()).toEqual({
    id: "autocomplete-option-human:github:person-0",
    visible: true,
  });
});

it.each([
  { transition: "empty", key: "Tab" },
  { transition: "empty", key: "Enter" },
  { transition: "loading", key: "Tab" },
  { transition: "loading", key: "Enter" },
])(
  "keeps the selected row visible after $transition and accepts it with $key",
  async ({ transition, key }) => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const { accepted, onSelect } = recordSelections();
    flushSync(() => root.render(<Harness people={[]} entries={files} onSelect={onSelect} />));
    await settleLayout();
    const expected = { id: "autocomplete-option-file:file-0.ts", visible: true };
    expect(selectedGeometry()).toEqual(expected);
    const previousScroll = container.querySelector('[data-testid="autocomplete-scroll"]')!;
    expect(previousScroll.scrollTop).toBeGreaterThan(0);

    flushSync(() =>
      root.render(
        <Harness
          people={[]}
          entries={transition === "empty" ? [] : files}
          isLoading={transition === "loading"}
          onSelect={onSelect}
        />,
      ),
    );
    await settleLayout();
    expect(container.querySelector('[data-testid="autocomplete-scroll"]')).toBeNull();

    flushSync(() => root.render(<Harness people={[]} entries={files} onSelect={onSelect} />));
    await settleLayout();
    const restoredScroll = container.querySelector('[data-testid="autocomplete-scroll"]')!;
    expect(restoredScroll).not.toBe(previousScroll);
    expect(selectedGeometry()).toEqual(expected);
    expect(restoredScroll.scrollTop).toBeGreaterThan(0);
    await userEvent.click(container.querySelector("input")!);
    await userEvent.keyboard(`{${key}}`);
    expect(accepted).toEqual(["file:file-0.ts"]);
  },
);
