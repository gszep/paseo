import React, { useCallback, useEffect, useMemo, useRef, type Ref } from "react";
import {
  ScrollView,
  Text,
  View,
  Pressable,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { File, Folder, UserRound } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { getAutocompleteScrollOffset } from "./autocomplete-utils";

export interface AutocompleteOption {
  id: string;
  label: string;
  detail?: string;
  description?: string;
  kind?: "command" | "file" | "directory" | "human";
}

interface AutocompleteProps {
  options: readonly AutocompleteOption[];
  selectedIndex: number;
  onSelect: (option: AutocompleteOption) => void;
  isLoading?: boolean;
  errorMessage?: string;
  loadingText?: string;
  emptyText?: string;
  maxHeight?: number;
}

const BOLT_GLYPH_PATTERN = /\u26A1|\uFE0F/gu;

function removeBoltGlyphs(value?: string): string | undefined {
  if (!value) {
    return value;
  }
  const cleaned = value.replace(BOLT_GLYPH_PATTERN, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

interface AutocompleteRowProps {
  option: AutocompleteOption;
  isSelected: boolean;
  mutedColor: string;
  onSelect: (option: AutocompleteOption) => void;
  rowRef?: Ref<View>;
  onLayout?: () => void;
}

function AutocompleteRow({
  option,
  isSelected,
  mutedColor,
  onSelect,
  rowRef,
  onLayout,
}: AutocompleteRowProps) {
  const optionLabel = removeBoltGlyphs(option.label) ?? option.label;
  const optionDescription = removeBoltGlyphs(option.description);
  const isFileOrDir = option.kind === "directory" || option.kind === "file";
  const hasIcon = isFileOrDir || option.kind === "human";

  const handlePress = useCallback(() => onSelect(option), [onSelect, option]);
  const pressableStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.item,
      (hovered || pressed || isSelected) && styles.itemActive,
    ],
    [isSelected],
  );

  return (
    <Pressable
      ref={rowRef}
      onLayout={onLayout}
      onPress={handlePress}
      style={pressableStyle}
      testID={`autocomplete-option-${option.id}`}
      aria-selected={isSelected}
    >
      {hasIcon ? (
        <>
          <View style={styles.itemLeading}>
            {option.kind === "human" ? <UserRound size={14} color={mutedColor} /> : null}
            {option.kind === "directory" ? <Folder size={14} color={mutedColor} /> : null}
            {option.kind === "file" ? <File size={14} color={mutedColor} /> : null}
          </View>
          <View style={styles.itemMain}>
            <View style={styles.itemHeader}>
              <Text style={styles.itemLabel}>{optionLabel}</Text>
              {removeBoltGlyphs(option.detail) ? (
                <Text style={styles.itemDetail}>{removeBoltGlyphs(option.detail)}</Text>
              ) : null}
            </View>
            {optionDescription ? (
              <Text style={styles.itemDescription} numberOfLines={1}>
                {optionDescription}
              </Text>
            ) : null}
          </View>
        </>
      ) : (
        <View style={styles.itemMainRow}>
          <Text style={styles.itemLabel}>{optionLabel}</Text>
          {optionDescription ? (
            <Text style={styles.itemDescriptionInline} numberOfLines={1}>
              {optionDescription}
            </Text>
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

export function Autocomplete({
  options,
  selectedIndex,
  onSelect,
  isLoading = false,
  errorMessage,
  loadingText,
  emptyText,
  maxHeight = 220,
}: AutocompleteProps) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const resolvedLoadingText = loadingText ?? t("common.states.loading");
  const resolvedEmptyText = emptyText ?? t("common.empty.noResults");
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  const selectedRowRef = useRef<View>(null);
  const measurementRef = useRef({ generation: 0 });
  const viewportHeightRef = useRef(0);
  const scrollOffsetRef = useRef(0);

  const setScrollRef = useCallback((scroll: ScrollView | null) => {
    scrollRef.current = scroll;
    // Empty/loading states unmount the scroller; a new instance starts at zero.
    scrollOffsetRef.current = 0;
    viewportHeightRef.current = 0;
    measurementRef.current.generation++;
  }, []);

  const ensureActiveItemVisible = useCallback(() => {
    const row = selectedRowRef.current;
    const content = contentRef.current;
    const measurement = ++measurementRef.current.generation;
    if (!row || !content) return;
    // Source updates can move a keyed row without another onLayout event on
    // web. Measure the selected row after layout instead of caching by index.
    row.measureLayout(content, (_left, top, _width, height) => {
      if (measurement !== measurementRef.current.generation || row !== selectedRowRef.current)
        return;
      const nextOffset = getAutocompleteScrollOffset({
        currentOffset: scrollOffsetRef.current,
        viewportHeight: viewportHeightRef.current,
        itemTop: top,
        itemHeight: height,
      });
      if (Math.abs(nextOffset - scrollOffsetRef.current) < 1) return;
      scrollOffsetRef.current = nextOffset;
      scrollRef.current?.scrollTo({ y: nextOffset, animated: false });
    });
  }, []);

  useEffect(() => {
    const measurement = measurementRef.current;
    const raf = requestAnimationFrame(ensureActiveItemVisible);
    return () => {
      cancelAnimationFrame(raf);
      measurement.generation++;
    };
  }, [ensureActiveItemVisible, options, selectedIndex]);

  const handleScrollViewLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeightRef.current = event.nativeEvent.layout.height;
      ensureActiveItemVisible();
    },
    [ensureActiveItemVisible],
  );

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const selectedOption = options[selectedIndex];
  const containerStyle = useMemo(() => [styles.container, { maxHeight }], [maxHeight]);

  if (isLoading) {
    return (
      <View style={containerStyle}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>{resolvedLoadingText}</Text>
        </View>
      </View>
    );
  }

  if (errorMessage) {
    return (
      <View style={containerStyle}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>Error: {errorMessage}</Text>
        </View>
      </View>
    );
  }

  if (options.length === 0) {
    return (
      <View style={containerStyle}>
        <View style={styles.emptyItem}>
          <Text style={styles.emptyText}>{resolvedEmptyText}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.outerWrapper}>
      {selectedOption?.kind === "command" && selectedOption.description ? (
        <View style={styles.detailCard}>
          <Text style={styles.detailLabel}>
            {removeBoltGlyphs(selectedOption.label) ?? selectedOption.label}
          </Text>
          <Text style={styles.detailDescription}>
            {removeBoltGlyphs(selectedOption.description)}
          </Text>
          {selectedOption.detail ? (
            <Text style={styles.detailHint}>{removeBoltGlyphs(selectedOption.detail)}</Text>
          ) : null}
        </View>
      ) : null}
      <View style={containerStyle}>
        <ScrollView
          ref={setScrollRef}
          onLayout={handleScrollViewLayout}
          onContentSizeChange={ensureActiveItemVisible}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          style={styles.scrollView}
          keyboardShouldPersistTaps="always"
          testID="autocomplete-scroll"
        >
          <View ref={contentRef} style={styles.scrollContent} collapsable={false}>
            {options.map((option, index) => (
              <AutocompleteRow
                key={option.id}
                option={option}
                isSelected={index === selectedIndex}
                mutedColor={theme.colors.foregroundMuted}
                onSelect={onSelect}
                rowRef={index === selectedIndex ? selectedRowRef : undefined}
                onLayout={index === selectedIndex ? ensureActiveItemVisible : undefined}
              />
            ))}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  outerWrapper: {
    flexShrink: 1,
    minHeight: 0,
    gap: theme.spacing[1],
  },
  detailCard: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    ...theme.shadow.md,
  },
  detailLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  detailDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  detailHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  container: {
    flexShrink: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    ...theme.shadow.md,
  },
  scrollView: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  itemLeading: {
    width: 18,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[1],
  },
  itemActive: {
    backgroundColor: theme.colors.surface2,
  },
  itemMain: {
    flex: 1,
    minWidth: 0,
  },
  itemMainRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  itemHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  itemLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  itemDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  itemDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  itemDescriptionInline: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
})) as unknown as Record<string, object>;
