import type { TFunction } from "i18next";

export type DateSectionKey = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";
export const DATE_SECTION_ORDER = ["today", "yesterday", "thisWeek", "thisMonth", "older"] as const;

export function deriveDateSectionKey(date: Date, now = new Date()): DateSectionKey {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (day >= today) return "today";
  if (day >= yesterday) return "yesterday";
  const days = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (days <= 7) return "thisWeek";
  if (days <= 30) return "thisMonth";
  return "older";
}

export function formatDateSectionLabel(t: TFunction, section: DateSectionKey): string {
  return t(`agentList.dateSections.${section}`);
}
