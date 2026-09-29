import type { ChiHandoff } from "@getpaseo/protocol/chi-mentions";
import { deriveDateSectionKey, type DateSectionKey } from "@/components/date-sections";

/** Sentinel for "no repository narrowing"; never a real repository id. */
export const ALL_REPOSITORIES_OPTION_ID = "__all_repositories__";

/** Repositories arrive as `github:owner/name`; the owner/name part is the readable label. */
export function repositoryLabel(repository: string): string {
  return repository.replace(/^github:/, "");
}

export type InboxListRow =
  | { key: string; section: DateSectionKey }
  | { key: string; handoff: ChiHandoff };

/**
 * Search is client-side over the pages already loaded. The backend inbox read has
 * no full-text query, so a match never widens coverage beyond what paging has
 * fetched; adding a server-side `q` would be the next step, not this one.
 */
export function filterInboxHandoffs(
  handoffs: readonly ChiHandoff[],
  input: { search: string; repository: string },
): ChiHandoff[] {
  const search = input.search.trim().toLowerCase();
  return handoffs.filter((handoff) => {
    if (input.repository !== ALL_REPOSITORIES_OPTION_ID && handoff.repo !== input.repository)
      return false;
    if (!search) return true;
    return (
      handoff.text.toLowerCase().includes(search) ||
      handoff.author.slice(7).toLowerCase().includes(search) ||
      handoff.recipient.slice(7).toLowerCase().includes(search) ||
      repositoryLabel(handoff.repo).toLowerCase().includes(search)
    );
  });
}

/** Distinct repositories across loaded pages, sorted by their readable labels. */
export function inboxRepositories(handoffs: readonly ChiHandoff[]): string[] {
  const repositories = new Set<string>();
  for (const handoff of handoffs) repositories.add(handoff.repo);
  return [...repositories].sort((left, right) =>
    repositoryLabel(left).localeCompare(repositoryLabel(right)),
  );
}

/**
 * Pages arrive newest-first, so date sections appear in order. Duplicate
 * repo/id pairs are dropped: paging can overlap after a first-view CAS.
 */
export function buildInboxRows(handoffs: readonly ChiHandoff[]): InboxListRow[] {
  const rows: InboxListRow[] = [];
  const seen = new Set<string>();
  let section: DateSectionKey | undefined;
  for (const handoff of handoffs) {
    const key = `${handoff.repo}/${handoff.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const next = deriveDateSectionKey(new Date(handoff.createdAt));
    if (next !== section) {
      rows.push({ key: next, section: next });
      section = next;
    }
    rows.push({ key, handoff });
  }
  return rows;
}
