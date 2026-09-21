import AsyncStorage from "@react-native-async-storage/async-storage";

const pending = new Map<string, Promise<string>>();

// Persist before dispatch: a reload or lost reply must name the same private receipt.
export async function continuationRequestId(key: string): Promise<string> {
  const previous = pending.get(key);
  if (previous) return previous;
  const operation = readOrCreateRequestId(key);
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    pending.delete(key);
  }
}

async function readOrCreateRequestId(key: string): Promise<string> {
  const storageKey = `chi-continuation:${key}`;
  const saved = await AsyncStorage.getItem(storageKey);
  if (saved !== null) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(saved))
      throw new Error("Invalid saved continuation request.");
    return saved;
  }
  const id = crypto.randomUUID();
  await AsyncStorage.setItem(storageKey, id);
  return id;
}

export async function clearContinuationRequest(key: string): Promise<void> {
  await AsyncStorage.removeItem(`chi-continuation:${key}`);
}

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
