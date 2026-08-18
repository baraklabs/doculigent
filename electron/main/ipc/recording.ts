import { ipcMain, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Channels } from "@shared/constants/channels";
import type { AreaRect, CameraTrackMetadata, CursorMetadata, OverlayConfig, Transcript, Video } from "@shared/types/models";
import { cameraBubbleRectForShape, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";
import { meetingsRoot, recordingsRoot } from "../native/paths";
import {
  convertToWav,
  copyToMp4,
  FfmpegCancelledError,
  muxScreenWithAudio,
  normalizeToCfr,
  overlayCameraBubble,
  probeDuration,
  remuxToMp4,
  transcodeScreenRecording,
  type CameraBubbleTrack,
} from "../native/ffmpeg";
import { insertVideo } from "../native/libraryStore";
import { writeCursorMetadata } from "../native/cursorTrack";
import { writeCameraMetadata } from "../native/cameraTrack";
import { writeTranscriptFile } from "../native/transcriptFile";
import { frameDimensions, loadCursorIcons, overlayCursorTrack, toFrameCoords } from "../native/cursorOverlay";
import { vfFor } from "../native/screenCapture";
import { getCameraBubbleConfig } from "../cameraBubbleWindow";

interface SideClip {
  bytes: ArrayBuffer;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface SaveRecordingInput {
  webmBytes?: ArrayBuffer;
  screenFilePath?: string;
  screenBytes?: ArrayBuffer;
  areaRect?: AreaRect | null;
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
  console.log("[recording] buildFinalMp4", {
    id,
    hasScreenFilePath: !!input.screenFilePath,
    hasScreenBytes: !!input.screenBytes,
    screenBytesLength: input.screenBytes?.byteLength,
    areaRect: input.areaRect,
    hasSideClip: !!input.sideClip,
    sideClipHasVideo: input.sideClip?.hasVideo,
    sideClipHasAudio: input.sideClip?.hasAudio,
  });

  if (input.screenFilePath || input.screenBytes) {
    const metaDir = path.join(recDir, "metadata");
    await fs.mkdir(metaDir, { recursive: true });
    const screenKeepPath = path.join(metaDir, "screen.mp4");

    if (input.screenFilePath) {
      if (process.platform === "darwin") {
        // macOS's native avfoundation capture is intentionally variable-frame-rate (see
        // native/screenCapture.ts's -fps_mode vfr) — normalize to a real CFR 30fps file
        // here so overlayCameraBubble/overlayCursorTrack downstream can keep assuming a
        // predictable frame count, same as Windows' native gdigrab output already is.
        const tempNativeScreen = path.join(os.tmpdir(), `${id}-screen-native.mp4`);
        await moveFile(input.screenFilePath, tempNativeScreen);
        cleanupPaths.push(tempNativeScreen);
        console.log("[recording] normalizing mac native capture to CFR", { tempNativeScreen });
        await normalizeToCfr(tempNativeScreen, screenKeepPath, onProgress, signal);
      } else {
        // Native (gdigrab) — already an mp4, already cropped/scaled and CFR at capture time.
        await moveFile(input.screenFilePath, screenKeepPath);
      }
    } else {
      // Non-native fallback — a raw, uncropped/unscaled getUserMedia recording of the
      // *whole* display (there's no way to crop at the capture source itself), transcoded
      // into the same shape a native capture already has: cropped to `areaRect` when given,
      // otherwise scaled/padded like a display capture — see native/screenCapture.ts's
      // `vfFor`, which the display/window branch here reuses so the two pipelines stay in
      // sync with each other.
      const tempScreenWebm = path.join(os.tmpdir(), `${id}-screen.webm`);
      await fs.writeFile(tempScreenWebm, Buffer.from(input.screenBytes!));
      cleanupPaths.push(tempScreenWebm);
      const area = input.areaRect;
      const vf = area
        ? `crop=iw*${area.width}:ih*${area.height}:iw*${area.x}:ih*${area.y},${vfFor(true)}`
        : vfFor(false);
      console.log("[recording] transcoding fallback screen recording", { tempScreenWebm, vf });
      try {
        await transcodeScreenRecording(tempScreenWebm, screenKeepPath, vf, onProgress, signal);
      } catch (e) {
        console.error("[recording] transcodeScreenRecording failed", e);
        throw e;
      }
    }

    if (!input.sideClip) {
      console.log("[recording] no side clip — copying screen straight to final mp4");
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
      console.log("[recording] overlaying camera bubble", {
        trackPoints: track.points.length,
        trackWidth: track.width,
        trackHeight: track.height,
        shape,
        mirror,
      });
      try {
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
      } catch (e) {
        console.error("[recording] overlayCameraBubble failed", e);
        throw e;
      }
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
  console.log("[recording] tryOverlayCursor", {
    found: !!metadata,
    points: metadata?.points.length,
    clicks: metadata?.clicks?.length,
    captureKind: metadata?.capture.kind,
    durationSecs,
  });
  if (!metadata || metadata.points.length === 0 || durationSecs <= 0) return;

  // durationSecs is the renderer's wall-clock estimate (elapsed time between
  // RecordingService.start()/stop() calls) — close, but not guaranteed to match finalMp4's
  // actual frame count exactly (e.g. avfoundation's screen device has a startup lag before
  // its first real frame arrives, systematically undershooting wall-clock time on macOS).
  // overlayCursorTrack precomputes exactly durationSecs*30 raw frames to pipe into ffmpeg
  // assuming that many exist in [0:v] — if there are fewer, ffmpeg finishes reading [0:v]
  // and closes its stdin first, and every write after that faults with EPIPE (confirmed).
  // Probing the file's real duration instead removes the guesswork entirely; a small
  // safety margin keeps a rounding-error frame from re-triggering the same race.
  const probedDurationSecs = await probeDuration(finalMp4);
  const overlayDurationSecs = probedDurationSecs > 0 ? Math.max(0, probedDurationSecs - 0.1) : durationSecs;

  const composedPath = path.join(recDir, "recording-with-cursor.mp4.tmp");
  try {
    const icons = await loadCursorIcons(metadata, path.join(recDir, "metadata", "cursor-icons"));
    await overlayCursorTrack(finalMp4, metadata, icons, overlayDurationSecs, composedPath, onProgress, signal);
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
  console.log("[recording] finishRecordingSave start", { id, finalMp4 });
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
    // screenBytes (the non-native fallback) already has a real, physically-captured OS
    // cursor baked into it — see SaveRecordingInput.screenBytes and EditProjectMedia's
    // cursorBakedIn. Burning the synthetic track on top of that would show two cursors, so
    // this overlay pass only ever runs for a native (gdigrab) screenFilePath, which never
    // has one baked in to begin with.
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
      cameraBubbleConfig: input.sideClip?.hasVideo ? getCameraBubbleConfig() : undefined,
      cursorBakedIn: !!input.screenBytes,
    };
    console.log("[recording] finishRecordingSave done", { id, cursorBakedIn: video.cursorBakedIn });
    insertVideo(video);
    if (!sender.isDestroyed()) sender.send(Channels.recording.saveCompleted, video);
  } catch (e) {
    console.error("[recording] finishRecordingSave failed", { id }, e);
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
    const saveDir = input.source === "meeting" ? meetingsRoot() : recordingsRoot();
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
    const saveDir = meetingsRoot();
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
