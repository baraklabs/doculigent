import { ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { Channels } from "@shared/constants/channels";
import type { Transcript, Video } from "@shared/types/models";
import { NotFoundError } from "@shared/ipc/errors";
import * as store from "../native/libraryStore";
import { removeTranscriptFile, writeTranscriptFile } from "../native/transcriptFile";

export function registerLibraryIpc(): void {
  ipcMain.handle(Channels.library.list, async (): Promise<Video[]> => store.listVideos());

  ipcMain.handle(Channels.library.get, async (_event, id: string): Promise<Video | null> => store.getVideo(id));

  ipcMain.handle(Channels.library.delete, async (_event, id: string, keepFile?: boolean): Promise<void> => {
    const video = store.getVideo(id);
    if (!video) throw new NotFoundError(`video ${id}`);
    store.deleteVideo(id);
    if (!keepFile) {
      await fs.rm(path.dirname(video.filePath), { recursive: true, force: true });
    }
  });

  ipcMain.handle(Channels.library.deleteMany, async (_event, ids: string[], keepFile?: boolean): Promise<void> => {
    const removed = store.deleteVideos(ids);
    if (!keepFile) {
      await Promise.all(removed.map((video) => fs.rm(path.dirname(video.filePath), { recursive: true, force: true })));
    }
  });

  ipcMain.handle(Channels.library.search, async (_event, query: string): Promise<Video[]> => store.searchVideos(query));

  ipcMain.handle(Channels.library.rename, async (_event, id: string, title: string): Promise<Video> => {
    const updated = store.renameVideo(id, title);
    if (!updated) throw new NotFoundError(`video ${id}`);
    return updated;
  });

  ipcMain.handle(
    Channels.library.setTranscript,
    async (_event, id: string, transcript: Transcript | null): Promise<Video> => {
      const updated = store.updateVideoTranscript(id, transcript);
      if (!updated) throw new NotFoundError(`video ${id}`);
      if (transcript) await writeTranscriptFile(updated.filePath, transcript);
      else await removeTranscriptFile(updated.filePath);
      return updated;
    }
  );
}
