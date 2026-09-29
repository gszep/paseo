import { expect, test } from "vitest";
import type { ChiHandoff } from "@getpaseo/protocol/chi-mentions";
import {
  ALL_REPOSITORIES_OPTION_ID,
  buildInboxRows,
  filterInboxHandoffs,
  inboxRepositories,
  repositoryLabel,
} from "./inbox-model";

const NOW = new Date();

function handoff(overrides: Partial<ChiHandoff> & Pick<ChiHandoff, "id" | "repo" | "text">) {
  const createdAt = overrides.createdAt ?? NOW.toISOString();
  return {
    schemaVersion: 1 as const,
    author: "github:alice",
    recipient: "github:me",
    sources: [{ kind: "neutral" as const, id: "src-1", snapshot: "a".repeat(64), entryId: "e1" }],
    state: "open" as const,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    events: [],
    ...overrides,
  } satisfies ChiHandoff;
}

const older = handoff({
  id: "11111111-1111-4111-8111-111111111111",
  repo: "github:acme/one",
  text: "Please review the billing change",
  createdAt: new Date(NOW.getTime() - 40 * 86400000).toISOString(),
});
const newer = handoff({
  id: "22222222-2222-4222-8222-222222222222",
  repo: "github:acme/two",
  text: "Check the terminal resize fix",
  recipient: "github:other",
});

test("filters by repository and free text over loaded rows", () => {
  expect(repositoryLabel("github:acme/one")).toBe("acme/one");
  expect(
    filterInboxHandoffs([older, newer], { search: "", repository: ALL_REPOSITORIES_OPTION_ID }),
  ).toHaveLength(2);
  expect(
    filterInboxHandoffs([older, newer], { search: "", repository: "github:acme/one" }),
  ).toEqual([older]);
  expect(
    filterInboxHandoffs([older, newer], {
      search: "billing",
      repository: ALL_REPOSITORIES_OPTION_ID,
    }),
  ).toEqual([older]);
  // Author and repository are searchable too, not just the body.
  expect(
    filterInboxHandoffs([older, newer], {
      search: "acme/two",
      repository: ALL_REPOSITORIES_OPTION_ID,
    }),
  ).toEqual([newer]);
  expect(
    filterInboxHandoffs([older, newer], {
      search: "nobody",
      repository: ALL_REPOSITORIES_OPTION_ID,
    }),
  ).toEqual([]);
});

test("derives sorted repository options from loaded pages", () => {
  expect(inboxRepositories([newer, older])).toEqual(["github:acme/one", "github:acme/two"]);
  expect(inboxRepositories([])).toEqual([]);
});

test("groups rows into date sections and drops page overlaps", () => {
  const rows = buildInboxRows([newer, newer, older]);
  expect(rows.map((row) => row.key)).toEqual([
    "today",
    `${newer.repo}/${newer.id}`,
    "older",
    `${older.repo}/${older.id}`,
  ]);
  expect(rows[0]).toMatchObject({ section: "today" });
});
