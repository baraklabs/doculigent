import type { Transcript, Video } from "@shared/types/models";
import { StorageProvider } from "../../providers/storage/StorageProvider";

export const LibraryService = {
  list(): Promise<Video[]> {
    return StorageProvider.list();
  },
  get(id: string): Promise<Video | null> {
    return StorageProvider.get(id);
  },
  delete(id: string, keepFile?: boolean): Promise<void> {
    return StorageProvider.delete(id, keepFile);
  },
  deleteMany(ids: string[], keepFile?: boolean): Promise<void> {
    return StorageProvider.deleteMany(ids, keepFile);
  },
  rename(id: string, title: string): Promise<Video> {
    return StorageProvider.rename(id, title);
  },
  setTranscript(id: string, transcript: Transcript | null): Promise<Video> {
    return StorageProvider.setTranscript(id, transcript);
  },
  pickFiles(kind: "video" | "audio", multi?: boolean): Promise<string[]> {
    return StorageProvider.pickFiles(kind, multi);
  },
  importFiles(filePaths: string[], kind: "video" | "audio"): Promise<Video[]> {
    return StorageProvider.importFiles(filePaths, kind);
  },
  onImportProgress(callback: (progress: { percent: number; fileIndex: number; totalFiles: number }) => void): () => void {
    return StorageProvider.onImportProgress(callback);
  },
};
