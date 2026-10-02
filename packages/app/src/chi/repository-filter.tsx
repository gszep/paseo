import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
import { Folder } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { Combobox, ComboboxItem, type ComboboxProps } from "@/components/ui/combobox";
import { FilterTrigger } from "@/components/ui/filter-trigger";
import { ALL_REPOSITORIES_OPTION_ID, repositoryLabel } from "@/chi/inbox-model";

const ThemedFolder = withUnistyles(Folder);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface RepositoryFilterProps {
  /** Repositories present in the loaded pages, in canonical `github:owner/name` form. */
  repositories: readonly string[];
  selected: string;
  onSelect: (repository: string) => void;
  triggerTestID?: string;
  optionTestID?: (repository: string) => string;
}

type RenderOption = NonNullable<ComboboxProps["renderOption"]>;

/**
 * The Mentions filter pill. Mentions arrive across repositories, so the
 * meaningful narrowing is by repository, not by host. Reuses the shared filter
 * trigger and the same anchored combobox the host filter uses.
 *
 * The trigger is a sibling of `Combobox`, never its child: Combobox children are
 * popup body content and only mount while the picker is open. A trigger placed
 * inside would be unreachable on both desktop and compact layouts.
 */
export function RepositoryFilter({
  repositories,
  selected,
  onSelect,
  triggerTestID,
  optionTestID,
}: RepositoryFilterProps): ReactElement {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterAnchorRef = useRef<View>(null);

  const options = useMemo(
    () => [
      { id: ALL_REPOSITORIES_OPTION_ID, label: "All repositories" },
      ...repositories.map((repository) => ({
        id: repository,
        label: repositoryLabel(repository),
      })),
    ],
    [repositories],
  );

  const selectedLabel = useMemo(
    () =>
      selected === ALL_REPOSITORIES_OPTION_ID ? "All repositories" : repositoryLabel(selected),
    [selected],
  );

  const handleFilterOpen = useCallback(() => setIsFilterOpen(true), []);

  const leading = useMemo(() => <ThemedFolder size={14} uniProps={mutedColorMapping} />, []);

  const renderOption = useCallback<RenderOption>(
    ({ option, selected: isSelected, active, onPress }) => (
      <ComboboxItem
        label={option.label}
        selected={isSelected}
        active={active}
        onPress={onPress}
        testID={optionTestID?.(option.id)}
      />
    ),
    [optionTestID],
  );

  return (
    <>
      <View ref={filterAnchorRef} collapsable={false} style={styles.filterTriggerWrap}>
        <FilterTrigger
          label={selectedLabel}
          onPress={handleFilterOpen}
          leading={leading}
          testID={triggerTestID}
          accessibilityLabel={`Filter: ${selectedLabel}`}
        />
      </View>
      <Combobox
        options={options}
        value={selected}
        onSelect={onSelect}
        renderOption={renderOption}
        open={isFilterOpen}
        onOpenChange={setIsFilterOpen}
        anchorRef={filterAnchorRef}
        searchable={repositories.length > 10}
        searchPlaceholder="Search repositories"
        title="Filter by repository"
        desktopPlacement="bottom-start"
      />
    </>
  );
}

const styles = StyleSheet.create(() => ({
  filterTriggerWrap: {
    alignSelf: "flex-start",
  },
}));
