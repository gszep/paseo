import AsyncStorage from "@react-native-async-storage/async-storage";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

/** Only source-prepared coordinates may enter the canonical destination operation. */
export async function preparedCoordinates(
  result: Awaited<ReturnType<DaemonClient["manageChiConversation"]>>,
  key: string,
) {
  if (result.outcome === "failed") throw new Error(result.error);
  if (!result.transfer) throw new Error("The source did not return a prepared transfer.");
  if (result.transfer.phase === "canceled") {
    await clearContinuationRequest(key);
    throw new Error("This transfer was canceled. Click Continue again to prepare a new transfer.");
  }
  return {
    repo: result.repo,
    sourceId: result.transfer.sourceId,
    snapshotId: result.transfer.snapshotId,
    canonical: { conversationId: result.conversationId, transferId: result.transfer.id },
  };
}

export interface ContinuationStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function createContinuationRequests(deps: {
  storage: ContinuationStorage;
  generateUuid(): string;
}) {
  const pending = new Map<string, Promise<string>>();

  async function readOrCreateRequestId(key: string): Promise<string> {
    const storageKey = `chi-continuation:${key}`;
    const saved = await deps.storage.getItem(storageKey);
    if (saved !== null) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(saved))
        throw new Error("Invalid saved continuation request.");
      return saved;
    }
    const id = deps.generateUuid();
    await deps.storage.setItem(storageKey, id);
    return id;
  }

  return {
    // Persist before dispatch: a reload or lost reply must name the same private receipt.
    async requestId(key: string): Promise<string> {
      const previous = pending.get(key);
      if (previous) return previous;
      const operation = readOrCreateRequestId(key);
      pending.set(key, operation);
      try {
        return await operation;
      } finally {
        pending.delete(key);
      }
    },
    async clear(key: string): Promise<void> {
      await deps.storage.removeItem(`chi-continuation:${key}`);
    },
  };
}

const requests = createContinuationRequests({
  storage: AsyncStorage,
  generateUuid: () => crypto.randomUUID(),
});

export const continuationRequestId = requests.requestId;
export const clearContinuationRequest = requests.clear;

export function currentWorkspaceCatalog<T extends { id: string }>(
  host: string,
  query: {
    isSuccess: boolean;
    isPlaceholderData: boolean;
    isFetching: boolean;
    data?: { serverId: string; entries: T[] };
  },
): T[] {
  return query.isSuccess &&
    !query.isPlaceholderData &&
    !query.isFetching &&
    query.data?.serverId === host
    ? query.data.entries
    : [];
}
/** A saved evidence pin is read-only; continuation requires a prepared transfer. */
export function validPreparedSelection(selection: {
  repo: string;
  sourceId: string;
  snapshotId: string;
  canonical?: { conversationId: string; transferId: string };
}): boolean {
  return (
    /^github:[^/\s]+\/[^/\s]+$/.test(selection.repo) &&
    /^[a-f0-9]{64}$/.test(selection.sourceId) &&
    /^[a-f0-9]{64}$/.test(selection.snapshotId) &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(selection.canonical?.conversationId ?? "") &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(selection.canonical?.transferId ?? "")
  );
}
