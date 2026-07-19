import type { Video } from "@shared/types/models";
import { StorageProvider } from "../../providers/storage/StorageProvider";

/** Backed by SQLite FTS5 over video titles + transcript text (see db.ts) — works today
 *  over titles, and over transcript text automatically once transcription (currently a
 *  stub, see transcription/TranscriptionService.ts) starts returning real segments. */
export const SearchService = {
  search(query: string): Promise<Video[]> {
    return StorageProvider.search(query);
  },
};
