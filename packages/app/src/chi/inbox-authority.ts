import type { ChiMentionContext } from "@getpaseo/protocol/chi-mentions";
import type { ContinuationStorage } from "./continuation-state";

type InboxPrincipal = Pick<ChiMentionContext, "actor" | "deployment">;
function sameInboxPrincipal(a: InboxPrincipal, b: InboxPrincipal) {
  return Boolean(a.deployment && a.actor === b.actor && a.deployment === b.deployment);
}

/** Host connection states that mean a host has finished its first connection attempt. */
type InboxHostConnectionStatus = "idle" | "connecting" | "online" | "offline" | "error";

/**
 * True once every configured host has reported a terminal connection state (or
 * there are no hosts). Until then the inbox must show a loading state rather
 * than claim no host is signed in — a host that is still connecting is not a
 * settled "no match".
 */
export function inboxHostsSettled(
  ids: readonly string[],
  statusOf: (id: string) => InboxHostConnectionStatus | undefined,
): boolean {
  if (ids.length === 0) return true;
  return ids.every((id) => {
    const status = statusOf(id);
    return status === "online" || status === "offline" || status === "error";
  });
}

// Shared by the sidebar and inbox. Transport churn must never change the signed-in recipient.
export function createInboxAuthority(storage: ContinuationStorage) {
  let principal: InboxPrincipal | null = null;
  let loading: Promise<void> | undefined;
  let binding: Promise<void> = Promise.resolve();
  const key = "chi-inbox-principal";
  async function hydrate() {
    loading ??= (async () => {
      const saved = await storage.getItem(key);
      if (!saved) return;
      const value = JSON.parse(saved);
      if (typeof value.actor !== "string" || typeof value.deployment !== "string")
        throw new Error("Reconnect or sign in to your Chi inbox.");
      principal = { actor: value.actor, deployment: value.deployment };
    })();
    await loading;
  }
  return {
    accepts(context: InboxPrincipal) {
      return principal !== null && sameInboxPrincipal(principal, context);
    },
    async resolve(
      candidates: readonly string[],
      preferred: string | undefined,
      verify: (host: string) => Promise<InboxPrincipal>,
    ) {
      await hydrate();
      const verified = await Promise.all(
        candidates.map(async (host) => {
          try {
            const identity = await verify(host);
            return identity.deployment ? { host, identity } : null;
          } catch {
            return null;
          }
        }),
      );
      const available = verified.filter((value) => value !== null);
      const task = binding.then(async () => {
        if (principal || !available.length) return undefined;
        const selected = available.find((value) => value.host === preferred);
        if (
          !selected &&
          available.some((value) => !sameInboxPrincipal(value.identity, available[0].identity))
        )
          throw new Error(
            "Multiple Chi accounts are connected. Select the host signed in to your inbox.",
          );
        const identity = (selected ?? available[0]).identity;
        await storage.setItem(key, JSON.stringify(identity));
        principal = identity;
        return undefined;
      });
      binding = task.catch(() => undefined);
      await task;
      const matching = available.filter(
        (value) => principal && sameInboxPrincipal(principal, value.identity),
      );
      const host = matching.find((value) => value.host === preferred)?.host ?? matching[0]?.host;
      if (!host)
        throw new Error("Reconnect a host signed in to your Chi inbox account and deployment.");
      return host;
    },
  };
}
