import type { ChiHandoff, ChiMentionContext } from "@getpaseo/protocol/chi-mentions";

/** Sentinel for "no repository narrowing"; never a real repository id. */
export const ALL_REPOSITORIES_OPTION_ID = "__all_repositories__";

/** Repositories arrive as `github:owner/name`; the owner/name part is the readable label. */
export function repositoryLabel(repository: string): string {
  return repository.replace(/^github:/, "");
}

export interface InboxListRow {
  key: string;
  handoff: ChiHandoff;
}

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
      inboxWorkspaceName(handoff).toLowerCase().includes(search) ||
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
 * Pages arrive newest-first. Duplicate
 * repo/id pairs are dropped: paging can overlap after a first-view CAS.
 */
export function buildInboxRows(handoffs: readonly ChiHandoff[]): InboxListRow[] {
  const rows: InboxListRow[] = [];
  const seen = new Set<string>();
  for (const handoff of handoffs) {
    const key = `${handoff.repo}/${handoff.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, handoff });
  }
  return rows;
}

/** Historical mentions may predate workspace labels. Keep their repository identifiable. */
export function inboxWorkspaceName(handoff: ChiHandoff): string {
  return handoff.workspaceName || repositoryLabel(handoff.repo).split("/").at(-1)!;
}

export function inboxRepositoryOptions(context: ChiMentionContext, catalog?: string[]): string[] {
  return (
    catalog ??
    context.repositories ??
    (context.defaultRepository ? [context.defaultRepository] : [])
  );
}

export function defaultInboxRepository(
  context: ChiMentionContext,
  repositories: string[],
): string | undefined {
  return context.defaultRepository ?? (repositories.length === 1 ? repositories[0] : undefined);
}
