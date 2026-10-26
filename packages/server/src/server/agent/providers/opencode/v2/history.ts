import type { SessionMessageInfo } from "@opencode/client";
import type { V2Api } from "./api.js";

export async function messages(
  client: V2Api,
  sessionID: string,
  signal?: AbortSignal,
): Promise<SessionMessageInfo[]> {
  const result: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await client.message.list(
      {
        sessionID,
        ...(cursor ? { cursor } : { order: "asc" }),
        limit: 100,
      },
      { signal },
    );
    signal?.throwIfAborted();
    result.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return result;
}
