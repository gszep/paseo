import type { BrandConfig } from "./brand";

export interface WindowTitleInput {
  /** The brand's title prefix, or null to leave the label unprefixed. */
  titleMark: Pick<BrandConfig, "titleMark">["titleMark"];
  /** The mark shown for this frame (the title mark when idle, a spinner frame while working). */
  mark: string;
  /** The session/tab label. */
  label: string;
}

/**
 * Formats the browser/window title. The default Paseo brand has no title mark
 * and leaves the label alone; a branded build renders `<mark>-<label>`.
 */
export function formatWindowTitle({ titleMark, mark, label }: WindowTitleInput): string {
  const resolved = label.trim();
  if (titleMark === null) return resolved;
  return `${mark}-${resolved || "Untitled session"}`;
}
