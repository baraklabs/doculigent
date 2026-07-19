import type { Transcript, Video } from "@shared/types/models";

/**
 * Thin abstraction over the storage backend (today: SQLite via IPC to the main
 * process — see electron/main/native/db.ts). Per prompt.md's architecture principles,
 * services depend on this, not on `window.api` directly, so a future swap (e.g. moving
 * storage behind a real local HTTP API per the Phase 3 roadmap) only touches this file.
 */
export const StorageProvider = {
  list(): Promise<Video[]> {
    return window.api.library.list();
  },
  get(id: string): Promise<Video | null> {
    return window.api.library.get(id);
  },
  delete(id: string): Promise<void> {
    return window.api.library.delete(id);
  },
  trim(id: string, startSecs: number, endSecs: number): Promise<Video> {
    return window.api.library.trim(id, startSecs, endSecs);
  },
  search(query: string): Promise<Video[]> {
    return window.api.library.search(query);
  },
  rename(id: string, title: string): Promise<Video> {
    return window.api.library.rename(id, title);
  },
  setTranscript(id: string, transcript: Transcript | null): Promise<Video> {
    return window.api.library.setTranscript(id, transcript);
  },
};
