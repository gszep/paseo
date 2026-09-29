import { useCallback, type ReactElement, type ReactNode } from "react";
import { Pressable, Text, type PressableStateCallbackType } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface FilterTriggerProps {
  label: string;
  onPress: () => void;
  /** Leading glyph or status dot; the chevron is added for every caller. */
  leading?: ReactNode;
  testID?: string;
  /** Falls back to `Filter: ${label}`, which already names the control. */
  accessibilityLabel?: string;
}

/**
 * The filter pill that leads a list's filter rail. History's host filter and the
 * Mentions repository filter share it, so both rails read as one row of controls
 * regardless of what each filters on.
 */
export function FilterTrigger({
  label,
  onPress,
  leading,
  testID,
  accessibilityLabel,
}: FilterTriggerProps): ReactElement {
  const triggerStyle = useCallback(
    ({ pressed, hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.trigger,
      Boolean(hovered) && styles.triggerHovered,
      pressed && styles.triggerPressed,
    ],
    [],
  );

  return (
    <Pressable
      onPress={onPress}
      style={triggerStyle}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `Filter: ${label}`}
    >
      {leading}
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerPressed: {
    backgroundColor: theme.colors.surface3,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
}));
