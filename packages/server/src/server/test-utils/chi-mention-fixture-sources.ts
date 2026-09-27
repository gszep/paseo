import { z } from "zod";

export const mentionFixtureTitle = "Synthetic human mention acceptance";
const pageSchema = z.object({
  items: z.array(
    z.object({ sourceId: z.string(), ownerId: z.string(), title: z.string().nullable() }),
  ),
  nextCursor: z.string().nullable(),
});

/** Test-account fixtures only. Gather all pages before deletion invalidates the cursor. */
export async function purgeMentionFixtureSources(input: {
  actor: string;
  list(cursor: string | null): Promise<unknown>;
  remove(sourceId: string): Promise<void>;
}) {
  const owned = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = pageSchema.parse(await input.list(cursor));
    for (const source of page.items) {
      if (
        source.ownerId.toLowerCase() === `github:${input.actor}` &&
        (source.title === mentionFixtureTitle ||
          source.title?.startsWith(`${mentionFixtureTitle} `))
      )
        owned.add(source.sourceId);
    }
    cursor = page.nextCursor;
  } while (cursor);
  for (const sourceId of owned) await input.remove(sourceId);
}
