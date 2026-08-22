import { dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Channels } from "@shared/constants/channels";
import type { OverlayConfig, Transcript, Video } from "@shared/types/models";
import { NotFoundError } from "@shared/ipc/errors";
import * as store from "../native/libraryStore";
import { removeTranscriptFile, writeTranscriptFile } from "../native/transcriptFile";
import { meetingsRoot, recordingsRoot, teamFileDir } from "../native/paths";
import { convertToWav, copyToMp4, copyVideoTranscodeAudio, probeDuration, probeMediaInfo, remuxToMp4, type MediaInfo } from "../native/ffmpeg";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".wmv", ".flv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".wma"]);

// Stream-copying H.264 straight into an MP4 container is rock solid for these — all
// ISO-BMFF/QuickTime-family containers where H.264 extradata is already stored the way MP4
// expects it. Deliberately narrower than "any container ffmpeg can demux" — MKV/AVI-wrapped
// H.264 occasionally has extradata quirks that make a naive `-c copy` remux exit 0 but
// produce a file that plays oddly in some players, so those still go through the full,
// always-safe `remuxToMp4` transcode below instead of being trusted to copy.
const STREAM_COPY_SAFE_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);

const NO_OVERLAY: OverlayConfig = {
  corner: "bottom-right",
  sizePct: 0,
  circular: false,
  showCamera: false,
  cameraDeviceId: null,
  mirrorCamera: false,
  cameraBlur: "none",
};

type PickKind = "video" | "audio";
async function transcodeIntoLibrary(
  filePath: string,
  kind: PickKind,
  recDir: string,
  sourceInfo: MediaInfo | null,
  onProgress?: (secondsDone: number) => void
): Promise<{ finalPath: string; durationSecs: number; fileKind: "video" | "audio" }> {
  await fs.mkdir(recDir, { recursive: true });
  const finalPath = kind === "video" ? path.join(recDir, "recording.mp4") : path.join(recDir, "audio.wav");

  if (kind === "video") {
    const info = sourceInfo!;
    const containerIsSafe = STREAM_COPY_SAFE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    const videoIsH264 = containerIsSafe && info.videoCodec === "h264";
    const audioIsCopyable = !info.audioCodec || info.audioCodec === "aac";
    try {
      if (videoIsH264 && audioIsCopyable) {
        await copyToMp4(filePath, finalPath, onProgress);
      } else if (videoIsH264) {
        await copyVideoTranscodeAudio(filePath, finalPath, onProgress);
      } else {
        // Genuinely needs conversion — AV1/VP8/VP9/ProRes/etc., or an H.264 source in a
        // container we don't trust to stream-copy (see STREAM_COPY_SAFE_EXTENSIONS).
        await remuxToMp4(filePath, finalPath, onProgress);
      }
    } catch (e) {
      // A stream copy can still fail on some real-world file (odd timestamps, an unusual
      // H.264 profile the mp4 muxer chokes on) even when the codec probe said it should
      // work — falling back to a full transcode is always safe, just slower.
      if (videoIsH264) {
        console.warn("[library] stream copy failed, falling back to full transcode", filePath, e);
        await remuxToMp4(filePath, finalPath, onProgress);
      } else {
        throw e;
      }
    }
  } else {
    await convertToWav(filePath, finalPath, onProgress);
  }

  const durationSecs = await probeDuration(finalPath);
  return { finalPath, durationSecs, fileKind: kind };
}

export interface ImportProgress {
  percent: number;
  fileIndex: number;
  totalFiles: number;
}
export async function importVideoFiles(
  filePaths: string[],
  kind: PickKind,
  onProgress?: (progress: ImportProgress) => void,
  syncedFromTeamFileId?: string,
  teamId?: string
): Promise<Video[]> {
  const imported: Video[] = [];
  const total = filePaths.length;
  for (let i = 0; i < total; i++) {
    const filePath = filePaths[i];
    const sourceInfo = kind === "video" ? await probeMediaInfo(filePath) : null;
    const sourceDuration = sourceInfo ? sourceInfo.durationSecs : await probeDuration(filePath);
    const id = randomUUID();
    const recDir =
      teamId && syncedFromTeamFileId
        ? teamFileDir(teamId, syncedFromTeamFileId)
        : path.join(kind === "audio" ? meetingsRoot() : recordingsRoot(), id);
    const { finalPath, durationSecs, fileKind } = await transcodeIntoLibrary(filePath, kind, recDir, sourceInfo, (secondsDone) => {
      const filePercent = sourceDuration > 0 ? Math.min(1, secondsDone / sourceDuration) : 0;
      onProgress?.({ percent: Math.round(((i + filePercent) / total) * 100), fileIndex: i, totalFiles: total });
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
      syncedFromTeamFileId,
    };
    store.insertVideo(video);
    imported.push(video);
  }
  onProgress?.({ percent: 100, fileIndex: total, totalFiles: total });
  return imported;
}

export function registerLibraryIpc(): void {
  ipcMain.handle(Channels.library.list, async (): Promise<Video[]> => store.listVideos());

  ipcMain.handle(Channels.library.get, async (_event, id: string): Promise<Video | null> => store.getVideo(id));

  ipcMain.handle(Channels.library.delete, async (_event, id: string, keepFile?: boolean): Promise<void> => {
    const video = store.getVideo(id);
    if (!video) throw new NotFoundError(`video ${id}`);
    store.deleteVideo(id);
    if (!keepFile) {
      await fs.rm(path.dirname(video.filePath), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  ipcMain.handle(Channels.library.deleteMany, async (_event, ids: string[], keepFile?: boolean): Promise<void> => {
    const removed = store.deleteVideos(ids);
    if (!keepFile) {
      await Promise.all(
        removed.map((video) =>
          fs.rm(path.dirname(video.filePath), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        )
      );
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

  ipcMain.handle(
    Channels.library.importFiles,
    async (event, filePaths: string[], kind: PickKind): Promise<Video[]> =>
      importVideoFiles(filePaths, kind, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send(Channels.library.importProgress, progress);
      })
  );
}
