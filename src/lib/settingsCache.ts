/**
 * In-memory copy of the last-known settings, so tabs (which unmount on navigation) can paint
 * their saved configuration on the very first render instead of flashing defaults while an IPC
 * round-trip resolves. Pages still re-fetch in the background and overwrite with fresh values.
 */
const store = new Map<string, unknown>();

export function peekCache<T>(key: string): T | undefined {
  return store.get(key) as T | undefined;
}

export function putCache<T>(key: string, value: T): T {
  store.set(key, value);
  return value;
}

/** Run `fetcher`, remember its result under `key`, and return it. */
export async function loadCached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  return putCache(key, await fetcher());
}

export const CACHE_KEYS = {
  record: "settings.record",
  meeting: "settings.meeting",
  transcription: "settings.transcription",
  whisperStatuses: "settings.whisperStatuses",
  whisperDir: "settings.whisperDir",
  recordingsDir: "settings.recordingsDir",
} as const;
