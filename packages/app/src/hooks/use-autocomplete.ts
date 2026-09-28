import { useCallback, useEffect, useState } from "react";
import {
  getAutocompleteSelectedIndex,
  handleAutocompleteKeyPress,
  type AutocompleteKeyPressEvent,
  type AutocompleteOptionsPosition,
  type AutocompleteSelection,
} from "@/components/ui/autocomplete-utils";

interface UseAutocompleteInput<
  TOption,
  TKeyPressEvent extends AutocompleteKeyPressEvent = AutocompleteKeyPressEvent,
> {
  isVisible: boolean;
  options: readonly TOption[];
  query: string;
  onSelectOption: (option: TOption, event?: TKeyPressEvent) => void;
  onEscape?: () => void;
  optionsPosition?: AutocompleteOptionsPosition;
}

interface UseAutocompleteResult<TKeyPressEvent extends AutocompleteKeyPressEvent> {
  selectedIndex: number;
  onKeyPress: (event: TKeyPressEvent) => boolean;
}

export function useAutocomplete<
  TOption extends { id: string },
  TKeyPressEvent extends AutocompleteKeyPressEvent = AutocompleteKeyPressEvent,
>(input: UseAutocompleteInput<TOption, TKeyPressEvent>): UseAutocompleteResult<TKeyPressEvent> {
  // Only arrow navigation fixes a selection. While sources arrive, the default
  // follows the best-ranked row; explicit navigation follows the exact option.
  const [selection, setSelection] = useState<AutocompleteSelection | null>(null);
  const selectedIndex = input.isVisible
    ? getAutocompleteSelectedIndex({ ...input, selection })
    : -1;

  useEffect(() => {
    setSelection(null);
  }, [input.isVisible, input.query]);

  const onKeyPress = useCallback(
    (event: TKeyPressEvent) =>
      handleAutocompleteKeyPress({
        ...input,
        event,
        selectedIndex,
        onSelectedIndexChange: (index) =>
          setSelection({ query: input.query, optionId: input.options[index]!.id }),
      }),
    [input, selectedIndex],
  );

  return {
    selectedIndex,
    onKeyPress,
  };
}
