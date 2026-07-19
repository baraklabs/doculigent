import { ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { Channels } from "@shared/constants/channels";
import type { Transcript, Video } from "@shared/types/models";
import { NotFoundError } from "@shared/ipc/errors";
import * as db from "../native/db";
import { removeTranscriptFile, writeTranscriptFile } from "../native/transcriptFile";

export function registerLibraryIpc(): void {
  ipcMain.handle(Channels.library.list, async (): Promise<Video[]> => db.listVideos());

  ipcMain.handle(Channels.library.get, async (_event, id: string): Promise<Video | null> => db.getVideo(id));

  ipcMain.handle(Channels.library.delete, async (_event, id: string): Promise<void> => {
    const video = db.getVideo(id);
    if (!video) throw new NotFoundError(`video ${id}`);
    db.deleteVideo(id);
    // Each recording lives in its own saveDir/{id}/ folder (see recording.ts) — remove
    // the whole thing, not just the media file, so a transcript.srt doesn't get left
    // behind as an orphaned file.
    await fs.rm(path.dirname(video.filePath), { recursive: true, force: true });
  });

  // Metadata-only stub (FUNCTIONALITY.md §9): updates duration in place rather than
  // re-encoding. Real implementation: ffmpeg `-ss <start> -to <end> -c copy`.
  ipcMain.handle(
    Channels.library.trim,
    async (_event, id: string, startSecs: number, endSecs: number): Promise<Video> => {
      const updated = db.updateVideoDuration(id, Math.max(0, endSecs - startSecs));
      if (!updated) throw new NotFoundError(`video ${id}`);
      return updated;
    }
  );

  ipcMain.handle(Channels.library.search, async (_event, query: string): Promise<Video[]> => db.searchVideos(query));

  ipcMain.handle(Channels.library.rename, async (_event, id: string, title: string): Promise<Video> => {
    const updated = db.renameVideo(id, title);
    if (!updated) throw new NotFoundError(`video ${id}`);
    return updated;
  });

  ipcMain.handle(
    Channels.library.setTranscript,
    async (_event, id: string, transcript: Transcript | null): Promise<Video> => {
      const updated = db.updateVideoTranscript(id, transcript);
      if (!updated) throw new NotFoundError(`video ${id}`);
      // Keeps transcript.srt in the recording's folder in sync with the DB — written
      // when a transcript is set, removed when it's cleared (the Transcribed section's
      // "delete transcript" action).
      if (transcript) await writeTranscriptFile(updated.filePath, transcript);
      else await removeTranscriptFile(updated.filePath);
      return updated;
    }
  );
}
