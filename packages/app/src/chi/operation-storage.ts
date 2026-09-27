import type { ContinuationStorage } from "./continuation-state";

// Forms and stores remount independently but share the same durable keys.
const lanes = new WeakMap<ContinuationStorage, Map<string, Promise<unknown>>>();

export async function withOperationStorage<T>(
  storage: ContinuationStorage,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  let keys = lanes.get(storage);
  if (!keys) {
    keys = new Map();
    lanes.set(storage, keys);
  }
  const task = (keys.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  keys.set(key, task);
  try {
    return await task;
  } finally {
    if (keys.get(key) === task) keys.delete(key);
  }
}
