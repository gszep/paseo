import { afterEach, describe, expect, it } from "vitest";
import {
  applyMentionAutocompleteOption,
  buildMentionAutocompleteOptions,
} from "@/composer/autocomplete";
import {
  clearMentionSelection,
  mentionSelection,
  selectedRecipients,
} from "@/chi/mention-selection";
import { findActiveFileMention } from "@/utils/file-mention-autocomplete";

import {
  getAutocompleteFallbackIndex,
  getAutocompleteSelectedIndex,
  getAutocompleteScrollOffset,
  handleAutocompleteKeyPress,
  orderAutocompleteOptions,
} from "./autocomplete-utils";

const OPTIONS = ["alpha", "beta", "gamma"];

describe("autocomplete keyboard acceptance", () => {
  const serverId = "autocomplete-host";
  const agentId = "autocomplete-agent";
  const context = {
    actor: "github:mochi-the-kitty",
    repo: "github:fixture/repo",
    generation: "a".repeat(64),
  };
  const participant = { ownerId: "github:sava-the-owl", handle: "sava-the-owl", context };
  const text = "@sa";
  const mention = findActiveFileMention({ text, cursorIndex: text.length })!;
  const files = [{ path: 'save "draft".ts', kind: "file" as const }];
  const options = buildMentionAutocompleteOptions({
    text,
    mention,
    participants: [participant],
    files,
  });

  afterEach(() => clearMentionSelection(serverId, agentId));

  it.each(["Tab", "Enter"])(
    "%s accepts the default participant and records the same recipient as clicking",
    (key) => {
      let prevented = false;
      let replacement = text;
      const event = {
        key,
        preventDefault: () => {
          prevented = true;
        },
        input: { text, selection: { start: 3, end: 3 } },
      };
      const handled = handleAutocompleteKeyPress({
        event,
        isVisible: true,
        options,
        selectedIndex: getAutocompleteSelectedIndex({ options, query: "sa", selection: null }),
        onSelectedIndexChange: () => {
          throw new Error("acceptance must not navigate");
        },
        onSelectOption: (option, acceptedEvent) => {
          expect(acceptedEvent).toBe(event);
          replacement = applyMentionAutocompleteOption({
            option,
            text: acceptedEvent.input.text,
            mention,
            serverId,
            agentId,
          });
        },
      });
      expect(handled).toBe(true);
      expect(prevented).toBe(true);
      expect(replacement).toBe("@sava-the-owl ");
      expect(mentionSelection(serverId, agentId)).toEqual([participant]);
      expect(selectedRecipients(serverId, agentId, replacement)).toEqual(["github:sava-the-owl"]);
      const clicked = applyMentionAutocompleteOption({
        option: options[1]!,
        text,
        mention,
        serverId,
        agentId,
      });
      expect(clicked).toBe(replacement);
      expect(mentionSelection(serverId, agentId)).toEqual([participant]);
      clearMentionSelection(serverId, agentId);
      expect(selectedRecipients(serverId, agentId, replacement)).toEqual([]);
    },
  );

  it.each(["Tab", "Enter"])(
    "%s accepts the highlighted file after ArrowUp without selecting a recipient",
    (key) => {
      let selectedIndex = getAutocompleteSelectedIndex({ options, query: "sa", selection: null });
      let replacement = text;
      const prevented: string[] = [];
      function press(pressedKey: string) {
        return handleAutocompleteKeyPress({
          event: {
            key: pressedKey,
            preventDefault: () => {
              prevented.push(pressedKey);
            },
          },
          isVisible: true,
          options,
          selectedIndex,
          onSelectedIndexChange: (index) => {
            selectedIndex = index;
          },
          onSelectOption: (option) => {
            replacement = applyMentionAutocompleteOption({
              option,
              text,
              mention,
              serverId,
              agentId,
            });
          },
        });
      }
      expect(press("ArrowUp")).toBe(true);
      expect(selectedIndex).toBe(0);
      expect(press("ArrowDown")).toBe(true);
      expect(selectedIndex).toBe(1);
      expect(press("ArrowUp")).toBe(true);
      expect(press(key)).toBe(true);
      expect(prevented).toEqual(["ArrowUp", "ArrowDown", "ArrowUp", key]);
      expect(replacement).toBe('"save \\"draft\\".ts"');
      expect(mentionSelection(serverId, agentId)).toEqual([]);
    },
  );

  it.each(["Tab", "Enter"])("%s keeps default behavior without a popup or any matches", (key) => {
    const fail = () => {
      throw new Error("unhandled keys must have no side effects");
    };
    for (const input of [
      { isVisible: false, options },
      { isVisible: true, options: [] },
    ]) {
      expect(
        handleAutocompleteKeyPress({
          ...input,
          event: { key, preventDefault: fail },
          selectedIndex: -1,
          onSelectedIndexChange: fail,
          onSelectOption: fail,
        }),
      ).toBe(false);
    }
  });

  it("updates the default as sources arrive and preserves arrow-selected identity across reordering", () => {
    const fileOnly = buildMentionAutocompleteOptions({ text, mention, participants: [], files });
    expect(getAutocompleteSelectedIndex({ options: fileOnly, query: "sa", selection: null })).toBe(
      0,
    );
    expect(getAutocompleteSelectedIndex({ options, query: "sa", selection: null })).toBe(1);
    const selection = { query: "sa", optionId: "human:github:sava-the-owl" };
    const withMoreFiles = buildMentionAutocompleteOptions({
      text,
      mention,
      participants: [participant],
      files: [...files, { path: "sample.ts", kind: "file" }],
    });
    expect(getAutocompleteSelectedIndex({ options: withMoreFiles, query: "sa", selection })).toBe(
      2,
    );
    expect(getAutocompleteSelectedIndex({ options: fileOnly, query: "sa", selection })).toBe(0);
    const fileSelection = { query: "sa", optionId: fileOnly[0]!.id };
    expect(getAutocompleteSelectedIndex({ options, query: "sa", selection: fileSelection })).toBe(
      0,
    );
    expect(getAutocompleteSelectedIndex({ options, query: "sav", selection: fileSelection })).toBe(
      1,
    );
  });
});

describe("orderAutocompleteOptions", () => {
  it("keeps first logical option closest to the input by default", () => {
    expect(orderAutocompleteOptions(OPTIONS)).toEqual(["gamma", "beta", "alpha"]);
  });

  it("keeps normal top-down order when below-input is selected", () => {
    expect(orderAutocompleteOptions(OPTIONS, "below-input")).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("getAutocompleteFallbackIndex", () => {
  it("picks the option nearest the input by default", () => {
    expect(getAutocompleteFallbackIndex(3)).toBe(2);
    expect(getAutocompleteFallbackIndex(0)).toBe(-1);
  });

  it("picks top item when below-input ordering is used", () => {
    expect(getAutocompleteFallbackIndex(3, "below-input")).toBe(0);
  });
});

describe("getAutocompleteScrollOffset", () => {
  it("scrolls up when the active item is above the viewport", () => {
    expect(
      getAutocompleteScrollOffset({
        currentOffset: 120,
        viewportHeight: 80,
        itemTop: 90,
        itemHeight: 20,
      }),
    ).toBe(90);
  });

  it("scrolls down when the active item is below the viewport", () => {
    expect(
      getAutocompleteScrollOffset({
        currentOffset: 0,
        viewportHeight: 100,
        itemTop: 150,
        itemHeight: 24,
      }),
    ).toBe(74);
  });
});
