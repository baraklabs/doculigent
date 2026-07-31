import type { Transcript, Video } from "@shared/types/models";

export const StorageProvider = {
  list(): Promise<Video[]> {
    return window.api.library.list();
  },
  get(id: string): Promise<Video | null> {
    return window.api.library.get(id);
  },
  delete(id: string, keepFile?: boolean): Promise<void> {
    return window.api.library.delete(id, keepFile);
  },
  deleteMany(ids: string[], keepFile?: boolean): Promise<void> {
    return window.api.library.deleteMany(ids, keepFile);
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
  pickFiles(kind: "video" | "audio", multi?: boolean): Promise<string[]> {
    return window.api.library.pickFiles(kind, multi);
  },
  importFiles(filePaths: string[], kind: "video" | "audio"): Promise<Video[]> {
    return window.api.library.importFiles(filePaths, kind);
  },
  onImportProgress(callback: (progress: { percent: number; fileIndex: number; totalFiles: number }) => void): () => void {
    return window.api.library.onImportProgress(callback);
  },
};
