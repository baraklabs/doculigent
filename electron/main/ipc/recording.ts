import { ipcMain, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Channels } from "@shared/constants/channels";
import type {
  OverlayConfig,
  RecordingSaveResult,
  SaveAudioInput,
  SaveRecordingInput,
  Video,
} from "@shared/types/models";
import {
  convertToWav,
  copyToMp4,
  FfmpegCancelledError,
  muxScreenWithAudio,
  normalizeToCfr,
  remuxToMp4,
  transcodeScreenRecording,
} from "../native/ffmpeg";
import { meetingsRoot, recordingsRoot } from "../native/paths";
import { insertVideo } from "../native/libraryStore";
import { writeCursorMetadata } from "../native/cursorTrack";
import { writeCameraMetadata } from "../native/cameraTrack";
import { writeTranscriptFile } from "../native/transcriptFile";
import { logNative } from "../native/nativeLog";
import { vfFor } from "../native/screenCapture";
import { createEditProject } from "../native/editProjectStore";

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

/** Resolves the final screen track from whichever of `screenFilePath`/`screenBytes` the
 *  input carries (native capture vs. the non-native getUserMedia fallback), writing
 *  straight to `outputPath` — shared by both the Quick (`buildFinalMp4`) and Advanced
 *  (`buildEditProjectMaterials`) paths, since both need the same resolution logic before
 *  branching on where the result needs to end up.
 *
 *  `needsCfr` gates the mac CFR-normalization re-encode below — only Advanced actually
 *  needs it (see that branch's comment), but this function used to run it unconditionally
 *  for *both* callers, silently turning Quick Recording's documented "at most a stream
 *  copy or an audio mux, never a compositing re-encode" (see buildFinalMp4's Quick-branch
 *  comment in finishRecordingSave) into a real ~1x-realtime libx264 pass on every mac Quick
 *  Recording — the dominant cost in a 10-minute recording taking another minute to save,
 *  and a second, separate ffmpeg progress run the save UI had no way to distinguish from
 *  the actual (fast) finishing pass. */
async function resolveScreenTrack(
  id: string,
  input: SaveRecordingInput,
  outputPath: string,
  onProgress: (secondsDone: number) => void,
  signal: AbortSignal,
  cleanupPaths: string[],
  needsCfr: boolean
): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  if (input.screenFilePath) {
    if (process.platform === "darwin" && needsCfr) {
      // macOS's native avfoundation capture is intentionally variable-frame-rate (see
      // native/screenCapture.ts's -fps_mode vfr) — normalize to a real CFR 30fps file so
      // anything downstream can keep assuming a predictable frame count, same as
      // Windows' native gdigrab output already is. Only Advanced needs this: its cursor/
      // camera overlay compositing (overlayCursorTrack) precomputes frame counts from
      // duration * 30 and faults on a VFR mismatch. Quick never runs that compositing (see
      // buildFinalMp4), so a VFR screen track is fine for it — playback and stream-copy/
      // mux both work fine straight off PTS timestamps, no fixed frame count assumed.
      const tempNativeScreen = path.join(os.tmpdir(), `${id}-screen-native.mp4`);
      await moveFile(input.screenFilePath, tempNativeScreen);
      cleanupPaths.push(tempNativeScreen);
      console.log("[recording] normalizing mac native capture to CFR", { tempNativeScreen });
      await normalizeToCfr(tempNativeScreen, outputPath, onProgress, signal);
    } else {
      // Native (gdigrab, or mac ScreenCaptureKit when the caller doesn't need CFR) —
      // already an mp4, no re-encode needed.
      await moveFile(input.screenFilePath, outputPath);
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
      await transcodeScreenRecording(tempScreenWebm, outputPath, vf, onProgress, signal);
    } catch (e) {
      console.error("[recording] transcodeScreenRecording failed", e);
      throw e;
    }
  }

  return outputPath;
}

/** Quick Recording only (Advanced uses `buildEditProjectMaterials`) — the camera bubble
 *  and cursor are already burnt into `screenFilePath`/`screenBytes` directly by the native
 *  capture (see `RecordingService.start()`'s `setContentProtected(false)` and the capture
 *  backend's own compositor-drawn cursor), so there's never a compositing pass to do here.
 *  `finalMp4` is still always produced via an actual ffmpeg pass (a cheap `-c copy` stream
 *  copy when there's no audio to mux in) rather than a raw file move/rename, to normalize
 *  container quirks between backends (gdigrab/WGC/SCK) into one consistent, predictable
 *  output shape. No `metadata/screen.mp4` intermediate either way — the screen track lands
 *  in a temp file instead. */
async function buildFinalMp4(
  id: string,
  input: SaveRecordingInput,
  finalMp4: string,
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
    hasSideClipAudio: input.sideClip?.hasAudio,
  });

  if (input.screenFilePath || input.screenBytes) {
    const tempScreenPath = path.join(os.tmpdir(), `${id}-screen-final.mp4`);
    cleanupPaths.push(tempScreenPath);
    // Quick never runs cursor/camera overlay compositing (see this function's Quick
    // branch below) — no need for a CFR screen track, see resolveScreenTrack's needsCfr.
    await resolveScreenTrack(id, input, tempScreenPath, onProgress, signal, cleanupPaths, false);

    if (!input.sideClip?.hasAudio) {
      await copyToMp4(tempScreenPath, finalMp4, onProgress, signal);
      return;
    }

    const audioPath = path.join(os.tmpdir(), `${id}-side.webm`);
    cleanupPaths.push(audioPath);
    await fs.writeFile(audioPath, Buffer.from(input.sideClip.bytes));
    await muxScreenWithAudio(tempScreenPath, audioPath, finalMp4, onProgress, signal);
    return;
  }

  const tempWebm = path.join(os.tmpdir(), `${id}.webm`);
  await fs.writeFile(tempWebm, Buffer.from(input.webmBytes!));
  cleanupPaths.push(tempWebm);
  await remuxToMp4(tempWebm, finalMp4, onProgress, signal);
}

/** The Advanced-mode counterpart to `buildFinalMp4` — produces the same
 *  `metadata/screen.mp4` (+ `metadata/camera.webm`, if a camera side clip was recorded)
 *  but never composites them into a single video. `cursor.json`/`camera.json` are already
 *  written unconditionally before this runs (see `registerRecordingIpc`'s `save`
 *  handler) — they're simply left in place instead of being read here. Also writes
 *  `metadata/recordMeta.json` so the editor can recover "as recorded" camera-bubble
 *  sizing and whether the screen track already has a physically-baked-in OS cursor
 *  (non-native fallback capture), the same fidelity a `Video`-sourced project gets from
 *  its library row. */
async function buildEditProjectMaterials(
  id: string,
  input: SaveRecordingInput,
  recDir: string,
  onProgress: (secondsDone: number) => void,
  signal: AbortSignal,
  cleanupPaths: string[]
): Promise<void> {
  const metaDir = path.join(recDir, "metadata");
  await fs.mkdir(metaDir, { recursive: true });

  if (input.screenFilePath || input.screenBytes) {
    // Advanced's editor overlays run against this track later (cursor/camera compositing
    // assumes a fixed frame count — see resolveScreenTrack's needsCfr) — must be CFR.
    await resolveScreenTrack(id, input, path.join(metaDir, "screen.mp4"), onProgress, signal, cleanupPaths, true);

    if (input.sideClip?.hasVideo) {
      await fs.writeFile(path.join(metaDir, "camera.webm"), Buffer.from(input.sideClip.bytes));
    } else if (input.sideClip) {
      // Audio-only side clip (mic/system audio, no camera video) — kept for completeness,
      // though full editor support for an audio-only Advanced project's sound track isn't
      // wired up yet.
      await fs.writeFile(path.join(metaDir, "audio.webm"), Buffer.from(input.sideClip.bytes));
    }
  } else {
    // Camera-only capture — a single already-composited stream (see RecordingService's
    // stopCameraOnly), not a separate screen+camera pair. Remux it straight into
    // metadata/screen.mp4 so getEditProjectMedia's single-file fallback still finds
    // something to edit, same as this mode's Quick-recording remuxToMp4 call does.
    const tempWebm = path.join(os.tmpdir(), `${id}.webm`);
    await fs.writeFile(tempWebm, Buffer.from(input.webmBytes!));
    cleanupPaths.push(tempWebm);
    await remuxToMp4(tempWebm, path.join(metaDir, "screen.mp4"), onProgress, signal);
  }

  await fs.writeFile(
    path.join(metaDir, "recordMeta.json"),
    JSON.stringify({ overlay: input.overlay, cursorBakedIn: !!input.screenBytes })
  );
}

async function finishRecordingSave(
  id: string,
  finalMp4: string,
  input: SaveRecordingInput,
  sender: IpcMainInvokeEvent["sender"]
): Promise<void> {
  console.log("[recording] finishRecordingSave start", { id, finalMp4, mode: input.mode });
  const abort = new AbortController();
  pendingSaves.set(id, abort);
  const cleanupPaths: string[] = [];
  const recDir = path.dirname(finalMp4);
  const onProgress = (secondsDone: number) => {
    if (sender.isDestroyed() || input.durationSecs <= 0) return;
    const percent = Math.max(0, Math.min(99, Math.round((secondsDone / input.durationSecs) * 100)));
    sender.send(Channels.recording.saveProgress, { id, percent });
  };
  try {
    if (input.mode === "advanced") {
      await buildEditProjectMaterials(id, input, recDir, onProgress, abort.signal, cleanupPaths);
      const project = createEditProject(input.title, { kind: "recording", recDir });
      console.log("[recording] finishRecordingSave done (advanced)", { id, editProjectId: project.id });
      const result: RecordingSaveResult = {
        kind: "editProject",
        recordingId: id,
        editProjectId: project.id,
        title: input.title,
      };
      if (!sender.isDestroyed()) sender.send(Channels.recording.saveCompleted, result);
    } else {
      // Quick Recording's native capture already has the camera bubble AND the cursor
      // burnt in directly — camera via RecordingService.start()'s
      // setContentProtected(false), cursor via the capture backend's own compositor-drawn
      // rendering (Windows.Graphics.Capture / ScreenCaptureKit, see native/screenCapture.ts)
      // — so buildFinalMp4 here is at most a stream copy or an audio mux, never a
      // compositing re-encode.
      await buildFinalMp4(id, input, finalMp4, onProgress, abort.signal, cleanupPaths);
      logNative(`finishRecordingSave (quick): hasScreenFilePath=${!!input.screenFilePath} durationSecs=${input.durationSecs}`);
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
        cursorBakedIn: true,
      };
      insertVideo(video);
      // No Edit Project for a Quick recording to read metadata/ afterward (cursor.json
      // isn't even written for Quick anymore — see the save handler below).
      await fs.rm(path.join(recDir, "metadata"), { recursive: true, force: true });
      console.log("[recording] finishRecordingSave done", { id, cursorBakedIn: video.cursorBakedIn });
      const result: RecordingSaveResult = { kind: "video", video };
      if (!sender.isDestroyed()) sender.send(Channels.recording.saveCompleted, result);
    }
  } catch (e) {
    console.error("[recording] finishRecordingSave failed", { id }, e);
    if (e instanceof FfmpegCancelledError) {
      await fs.rm(recDir, { recursive: true, force: true });
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
    // Cursor and camera-position tracking are both Advanced-only now — Quick's native
    // capture backend burns both directly into the pixels at capture time (see
    // RecordingService.start()), nothing left to track for either.
    logNative(`recording.save: id=${id} mode=${input.mode ?? "quick"} hasScreenFilePath=${!!input.screenFilePath}`);
    if (input.mode === "advanced") {
      await writeCursorMetadata(id, recDir);
      await writeCameraMetadata(id, recDir);
    }
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
