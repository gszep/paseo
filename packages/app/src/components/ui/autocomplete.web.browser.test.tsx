import React, { useCallback } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "@vitest/browser/context";
import { Autocomplete, type AutocompleteOption } from "./autocomplete";
import { useAutocomplete } from "@/hooks/use-autocomplete";
import {
  buildMentionAutocompleteOptions,
  type DirectorySuggestionEntry,
} from "@/composer/autocomplete";
import type { SelectedMention } from "@/chi/mention-selection";

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
}

const harnessStyle = { width: 360 };

function recordSelections() {
  const accepted: string[] = [];
  return { accepted, onSelect: (id: string) => accepted.push(id) };
}

function ignoreSelection() {}

function Harness({ people, entries, onSelect }: HarnessProps) {
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
});

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
