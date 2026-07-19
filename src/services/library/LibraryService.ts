import type { Transcript, Video } from "@shared/types/models";
import { StorageProvider } from "../../providers/storage/StorageProvider";

export const LibraryService = {
  list(): Promise<Video[]> {
    return StorageProvider.list();
  },
  get(id: string): Promise<Video | null> {
    return StorageProvider.get(id);
  },
  delete(id: string): Promise<void> {
    return StorageProvider.delete(id);
  },
  trim(id: string, startSecs: number, endSecs: number): Promise<Video> {
    return StorageProvider.trim(id, startSecs, endSecs);
  },
  rename(id: string, title: string): Promise<Video> {
    return StorageProvider.rename(id, title);
  },
  setTranscript(id: string, transcript: Transcript | null): Promise<Video> {
    return StorageProvider.setTranscript(id, transcript);
  },
};
