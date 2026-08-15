import { ipcMain, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Channels } from "@shared/constants/channels";
import type { CameraTrackMetadata, CursorMetadata, OverlayConfig, Transcript, Video } from "@shared/types/models";
import { cameraBubbleRectForShape, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";
import { ensureSaveDir } from "../native/paths";
import {
  convertToWav,
  copyToMp4,
  FfmpegCancelledError,
  muxScreenWithAudio,
  overlayCameraBubble,
  remuxToMp4,
  type CameraBubbleTrack,
} from "../native/ffmpeg";
import { insertVideo } from "../native/libraryStore";
import { writeCursorMetadata } from "../native/cursorTrack";
import { writeCameraMetadata } from "../native/cameraTrack";
import { writeTranscriptFile } from "../native/transcriptFile";
import { frameDimensions, loadCursorIcons, overlayCursorTrack, toFrameCoords } from "../native/cursorOverlay";
import { getCameraBubbleConfig } from "../cameraBubbleWindow";

interface SideClip {
  bytes: ArrayBuffer;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface SaveRecordingInput {
  webmBytes?: ArrayBuffer;
  screenFilePath?: string;
  sideClip?: SideClip;
  overlay: OverlayConfig;
  durationSecs: number;
  title: string;
  source: "record" | "meeting";
}

interface SaveAudioInput {
  audioBytes: ArrayBuffer;
  durationSecs: number;
  title: string;
  transcript: Transcript | null;
}

const AUDIO_OVERLAY: OverlayConfig = {
  corner: "bottom-right",
  sizePct: 0,
  circular: false,
  showCamera: false,
  cameraDeviceId: null,
  mirrorCamera: false,
  cameraBlur: "none",
};

function recordingDir(saveDir: string, id: string): string {
  return path.join(saveDir, id);
}

const pendingSaves = new Map<string, AbortController>();

async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await fs.copyFile(src, dest);
    await fs.rm(src, { force: true });
  }
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function resolveCameraBubbleTrack(recDir: string, overlay: OverlayConfig): Promise<CameraBubbleTrack> {
  const shape = getCameraBubbleConfig().shape;
  const fallback = cameraBubbleRectForShape(overlay, shape, OUTPUT_WIDTH, OUTPUT_HEIGHT);
  const fallbackTrack: CameraBubbleTrack = {
    width: fallback.width,
    height: fallback.height,
    points: [{ atSec: 0, x: fallback.x, y: fallback.y }],
  };
  try {
    const cursorMeta = await readJsonIfExists<CursorMetadata>(path.join(recDir, "metadata", "cursor.json"));
    const cameraMeta = await readJsonIfExists<CameraTrackMetadata>(path.join(recDir, "metadata", "camera.json"));
    if (!cursorMeta || !cameraMeta || cameraMeta.points.length === 0) return fallbackTrack;

    const { width: frameW, height: frameH } = frameDimensions(cursorMeta);

    const lastRaw = cameraMeta.points[cameraMeta.points.length - 1];
    const lastTopLeft = toFrameCoords(cursorMeta, lastRaw.x, lastRaw.y);
    const lastBottomRight = toFrameCoords(cursorMeta, lastRaw.x + lastRaw.width, lastRaw.y + lastRaw.height);
    const trackedWidth = lastTopLeft && lastBottomRight ? Math.round(lastBottomRight.x - lastTopLeft.x) : 0;
    const trackedHeight = lastTopLeft && lastBottomRight ? Math.round(lastBottomRight.y - lastTopLeft.y) : 0;
    const width = trackedWidth > 0 ? trackedWidth : fallback.width;
    const height = trackedHeight > 0 ? trackedHeight : fallback.height;

    const points = cameraMeta.points.flatMap((p) => {
      const pos = toFrameCoords(cursorMeta, p.x, p.y);
      if (!pos) return [];
      return [
        {
          atSec: Math.max(0, p.t / 1000),
          x: Math.round(Math.min(Math.max(pos.x, 0), frameW - width)),
          y: Math.round(Math.min(Math.max(pos.y, 0), frameH - height)),
        },
      ];
    });
    if (points.length === 0) return fallbackTrack;
    return { width, height, points };
  } catch {
    return fallbackTrack;
  }
}

async function buildFinalMp4(
  id: string,
  input: SaveRecordingInput,
  finalMp4: string,
  recDir: string,
  onProgress: (secondsDone: number) => void,
  signal: AbortSignal,
  cleanupPaths: string[]
): Promise<void> {
  if (input.screenFilePath) {
    const metaDir = path.join(recDir, "metadata");
    await fs.mkdir(metaDir, { recursive: true });
    const screenKeepPath = path.join(metaDir, "screen.mp4");
    await moveFile(input.screenFilePath, screenKeepPath);

    if (!input.sideClip) {
      await copyToMp4(screenKeepPath, finalMp4, onProgress, signal);
      return;
    }

    const sideClipPath = input.sideClip.hasVideo
      ? path.join(metaDir, "camera.webm")
      : path.join(os.tmpdir(), `${id}-side.webm`);
    await fs.writeFile(sideClipPath, Buffer.from(input.sideClip.bytes));
    if (!input.sideClip.hasVideo) cleanupPaths.push(sideClipPath);

    if (input.sideClip.hasVideo) {
      const track = await resolveCameraBubbleTrack(recDir, input.overlay);
      const { shape, mirror } = getCameraBubbleConfig();
      await overlayCameraBubble(
        screenKeepPath,
        sideClipPath,
        track,
        shape,
        mirror,
        input.sideClip.hasAudio,
        finalMp4,
        onProgress,
        signal
      );
    } else {
      await muxScreenWithAudio(screenKeepPath, sideClipPath, finalMp4, onProgress, signal);
    }
    return;
  }

  const tempWebm = path.join(os.tmpdir(), `${id}.webm`);
  await fs.writeFile(tempWebm, Buffer.from(input.webmBytes!));
  cleanupPaths.push(tempWebm);
  await remuxToMp4(tempWebm, finalMp4, onProgress, signal);
}

async function tryOverlayCursor(
  recDir: string,
  finalMp4: string,
  durationSecs: number,
  onProgress: (secondsDone: number) => void,
  signal: AbortSignal
): Promise<void> {
  const metaPath = path.join(recDir, "metadata", "cursor.json");
  const metadata = await readJsonIfExists<CursorMetadata>(metaPath);
  if (!metadata || metadata.points.length === 0 || durationSecs <= 0) return;

  const composedPath = path.join(recDir, "recording-with-cursor.mp4.tmp");
  try {
    const icons = await loadCursorIcons(metadata, path.join(recDir, "metadata", "cursor-icons"));
    await overlayCursorTrack(finalMp4, metadata, icons, durationSecs, composedPath, onProgress, signal);
    await moveFile(composedPath, finalMp4);
  } catch (e) {
    await fs.rm(composedPath, { force: true });
    if (signal.aborted) throw new FfmpegCancelledError();
    console.error("Cursor overlay pass failed, keeping the plain composite:", e);
  }
}

async function finishRecordingSave(
  id: string,
  finalMp4: string,
  input: SaveRecordingInput,
  sender: IpcMainInvokeEvent["sender"]
): Promise<void> {
  const abort = new AbortController();
  pendingSaves.set(id, abort);
  const cleanupPaths: string[] = [];
  try {
    await buildFinalMp4(
      id,
      input,
      finalMp4,
      path.dirname(finalMp4),
      (secondsDone) => {
        if (sender.isDestroyed() || input.durationSecs <= 0) return;
        const percent = Math.max(0, Math.min(99, Math.round((secondsDone / input.durationSecs) * 100)));
        sender.send(Channels.recording.saveProgress, { id, percent });
      },
      abort.signal,
      cleanupPaths
    );
    if (input.screenFilePath) {
      await tryOverlayCursor(
        path.dirname(finalMp4),
        finalMp4,
        input.durationSecs,
        (secondsDone) => {
          if (sender.isDestroyed() || input.durationSecs <= 0) return;
          const percent = Math.max(0, Math.min(99, Math.round((secondsDone / input.durationSecs) * 100)));
          sender.send(Channels.recording.saveProgress, { id, percent });
        },
        abort.signal
      );
    }
    const video: Video = {
      id,
      title: input.title,
      filePath: finalMp4,
      durationSecs: input.durationSecs,
      overlay: input.overlay,
      createdAt: new Date().toISOString(),
      transcript: null,
      summary: null,
      source: input.source,
    };
    insertVideo(video);
    if (!sender.isDestroyed()) sender.send(Channels.recording.saveCompleted, video);
  } catch (e) {
    if (e instanceof FfmpegCancelledError) {
      await fs.rm(path.dirname(finalMp4), { recursive: true, force: true });
    } else if (!sender.isDestroyed()) {
      sender.send(Channels.recording.saveFailed, { id, message: String(e) });
    }
  } finally {
    pendingSaves.delete(id);
    await Promise.all(cleanupPaths.map((p) => fs.rm(p, { force: true })));
  }
}

export function registerRecordingIpc(): void {
  ipcMain.handle(Channels.recording.save, async (event, input: SaveRecordingInput): Promise<{ id: string }> => {
    const saveDir = ensureSaveDir();
    const id = randomUUID();
    const recDir = recordingDir(saveDir, id);
    await fs.mkdir(recDir, { recursive: true });
    const finalMp4 = path.join(recDir, "recording.mp4");
    await writeCursorMetadata(id, recDir);
    await writeCameraMetadata(id, recDir);
    void finishRecordingSave(id, finalMp4, input, event.sender);

    return { id };
  });
  ipcMain.handle(Channels.recording.cancelSave, async (_event, id: string): Promise<boolean> => {
    const abort = pendingSaves.get(id);
    if (!abort) return false;
    abort.abort();
    return true;
  });

  ipcMain.handle(Channels.recording.saveAudio, async (_event, input: SaveAudioInput): Promise<Video> => {
    const saveDir = ensureSaveDir();
    const id = randomUUID();
    const recDir = recordingDir(saveDir, id);
    await fs.mkdir(recDir, { recursive: true });
    const tempWebm = path.join(os.tmpdir(), `${id}.webm`);
    const finalWav = path.join(recDir, "audio.wav");

    await fs.writeFile(tempWebm, Buffer.from(input.audioBytes));
    try {
      await convertToWav(tempWebm, finalWav);
    } finally {
      await fs.rm(tempWebm, { force: true });
    }

    const video: Video = {
      id,
      title: input.title,
      filePath: finalWav,
      durationSecs: input.durationSecs,
      overlay: AUDIO_OVERLAY,
      createdAt: new Date().toISOString(),
      transcript: input.transcript,
      summary: null,
      source: "meeting",
    };
    insertVideo(video);
    if (input.transcript) await writeTranscriptFile(finalWav, input.transcript);
    return video;
  });
}
