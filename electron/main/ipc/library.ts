import { dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Channels } from "@shared/constants/channels";
import type { OverlayConfig, Transcript, Video } from "@shared/types/models";
import { NotFoundError } from "@shared/ipc/errors";
import * as store from "../native/libraryStore";
import { removeTranscriptFile, writeTranscriptFile } from "../native/transcriptFile";
import { ensureSaveDir } from "../native/paths";
import { convertToWav, probeDuration, remuxToMp4 } from "../native/ffmpeg";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".wmv", ".flv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".wma"]);

const NO_OVERLAY: OverlayConfig = {
  corner: "bottom-right",
  sizePct: 0,
  circular: false,
  showCamera: false,
  cameraDeviceId: null,
  cursorHighlight: "default",
};

type PickKind = "video" | "audio";

/** Transcodes a picked media file into the library's own copy (video → mp4, audio → wav —
 *  matches the formats the rest of the app already produces/expects) and returns everything
 *  needed to build its Video record. `onProgress` reports seconds of the *source* file
 *  processed so far, for callers that know the source's duration up front. */
async function transcodeIntoLibrary(
  filePath: string,
  kind: PickKind,
  onProgress?: (secondsDone: number) => void
): Promise<{ id: string; finalPath: string; durationSecs: number; fileKind: "video" | "audio" }> {
  const saveDir = ensureSaveDir();
  const id = randomUUID();
  const recDir = path.join(saveDir, id);
  await fs.mkdir(recDir, { recursive: true });
  const finalPath = kind === "video" ? path.join(recDir, "recording.mp4") : path.join(recDir, "audio.wav");

  if (kind === "video") await remuxToMp4(filePath, finalPath, onProgress);
  else await convertToWav(filePath, finalPath, onProgress);

  const durationSecs = await probeDuration(finalPath);
  return { id, finalPath, durationSecs, fileKind: kind };
}

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

  ipcMain.handle(Channels.library.pickFiles, async (_event, kind: PickKind, multi = true): Promise<string[]> => {
    const filters =
      kind === "video"
        ? [{ name: "Video files", extensions: [...VIDEO_EXTENSIONS].map((e) => e.slice(1)) }]
        : [{ name: "Audio files", extensions: [...AUDIO_EXTENSIONS].map((e) => e.slice(1)) }];
    const properties: ("openFile" | "multiSelections")[] = multi ? ["openFile", "multiSelections"] : ["openFile"];
    const result = await dialog.showOpenDialog({ properties, filters });
    return result.canceled ? [] : result.filePaths;
  });

  // Reports progress on Channels.library.importProgress as each file transcodes — percent
  // is overall progress across the whole batch (file index + that file's own encode
  // progress, weighted by 1/total), not just the file currently in flight, so a multi-file
  // import shows one smoothly advancing bar instead of resetting per file.
  ipcMain.handle(
    Channels.library.importFiles,
    async (event, filePaths: string[], kind: PickKind): Promise<Video[]> => {
      const imported: Video[] = [];
      const total = filePaths.length;
      for (let i = 0; i < total; i++) {
        const filePath = filePaths[i];
        const sourceDuration = await probeDuration(filePath);
        const { id, finalPath, durationSecs, fileKind } = await transcodeIntoLibrary(filePath, kind, (secondsDone) => {
          if (event.sender.isDestroyed()) return;
          const filePercent = sourceDuration > 0 ? Math.min(1, secondsDone / sourceDuration) : 0;
          const percent = Math.round(((i + filePercent) / total) * 100);
          event.sender.send(Channels.library.importProgress, { percent, fileIndex: i, totalFiles: total });
        });
        const video: Video = {
          id,
          title: path.basename(filePath, path.extname(filePath)),
          filePath: finalPath,
          durationSecs,
          overlay: NO_OVERLAY,
          createdAt: new Date().toISOString(),
          transcript: null,
          summary: null,
          source: fileKind === "audio" ? "meeting" : "record",
        };
        store.insertVideo(video);
        imported.push(video);
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send(Channels.library.importProgress, { percent: 100, fileIndex: total, totalFiles: total });
      }
      return imported;
    }
  );
}
