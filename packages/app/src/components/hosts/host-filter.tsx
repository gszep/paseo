import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { View } from "react-native";
import { Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { HostProfile } from "@/types/host-connection";
import type { Theme } from "@/styles/theme";
import { FilterTrigger } from "@/components/ui/filter-trigger";
import {
  ALL_HOSTS_OPTION_ID,
  getHostPickerLabel,
  HostPicker,
  HostStatusDotSlot,
} from "@/components/hosts/host-picker";

const ThemedServer = withUnistyles(Server);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface HostFilterProps {
  hosts: HostProfile[];
  selectedHost: string;
  onSelectHost: (serverId: string) => void;
  /**
   * Offer "All hosts". Off for a surface that acts on exactly one host's data — the label
   * manager edits a single host's catalog, so "all" is not an answer it could carry out.
   */
  includeAllHost?: boolean;
  triggerTestID?: string;
  hostOptionTestID?: (serverId: string) => string;
}

/**
 * The "All hosts / <host>" filter pill shared by the History and Schedules
 * screens: an anchored HostPicker with `includeAllHost`, hidden by the caller
 * when only one host exists.
 */
export function HostFilter({
  hosts,
  selectedHost,
  onSelectHost,
  includeAllHost = true,
  triggerTestID,
  hostOptionTestID,
}: HostFilterProps): ReactElement {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterAnchorRef = useRef<View>(null);

  const selectedHostLabel = useMemo(
    () => getHostPickerLabel(hosts, selectedHost, { includeAllHost }),
    [hosts, includeAllHost, selectedHost],
  );

  const handleFilterOpen = useCallback(() => setIsFilterOpen(true), []);

  const leading = useMemo(
    () =>
      selectedHost === ALL_HOSTS_OPTION_ID ? (
        <ThemedServer size={14} uniProps={mutedColorMapping} />
      ) : (
        <HostStatusDotSlot serverId={selectedHost} />
      ),
    [selectedHost],
  );

  return (
    <HostPicker
      hosts={hosts}
      value={selectedHost}
      onSelect={onSelectHost}
      open={isFilterOpen}
      onOpenChange={setIsFilterOpen}
      anchorRef={filterAnchorRef}
      includeAllHost={includeAllHost}
      searchable={false}
      title="Filter by host"
      desktopPlacement="bottom-start"
      hostOptionTestID={hostOptionTestID}
    >
      <View ref={filterAnchorRef} collapsable={false} style={styles.filterTriggerWrap}>
        <FilterTrigger
          label={selectedHostLabel}
          onPress={handleFilterOpen}
          leading={leading}
          testID={triggerTestID}
          accessibilityLabel={`Filter: ${selectedHostLabel}`}
        />
      </View>
    </HostPicker>
  );
}

const styles = StyleSheet.create(() => ({
  filterTriggerWrap: {
    alignSelf: "flex-start",
  },
}));
