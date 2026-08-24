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
  SaveRecordingSideClip,
  Video,
} from "@shared/types/models";
import {
  convertToWav,
  copyToMp4,
  FfmpegCancelledError,
  muxScreenWithAudio,
  probeDuration,
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
 *  A native capture is never re-encoded here on any platform — the file is just moved into
 *  place. macOS used to additionally run a full CFR-normalization re-encode
 *  (`normalizeToCfr`, since deleted) because its captures are variable-frame-rate, which
 *  cost ~90s on a 10-minute recording and was the single dominant cost of saving. That pass
 *  existed for `overlayCursorTrack`, an ffmpeg compositing step that precomputed its frame
 *  count as `durationSecs * 30` and so faulted on VFR input — but that step was deleted
 *  when native compositor-drawn cursor capture replaced it (see native/cursorOverlay.ts),
 *  leaving the expensive workaround behind with nothing left to protect. Nothing downstream
 *  needs CFR now: the editor composites on a canvas driven by `video.currentTime`
 *  (PreviewCompositor.tsx) and exports via `canvas.captureStream()`, both of which seek by
 *  timestamp and never assume a fixed frame count. `overlayCameraBubble` is likewise
 *  time-based (`stepExpr` keys off `t`) and currently uncalled. */
async function resolveScreenTrack(
  id: string,
  input: SaveRecordingInput,
  outputPath: string,
  onProgress: (secondsDone: number) => void,
  signal: AbortSignal,
  cleanupPaths: string[]
): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  if (input.screenFilePath) {
    // Native capture (gdigrab/WGC on Windows, ScreenCaptureKit on mac) — already a
    // finished mp4 at its final size, so this is a move, never a re-encode.
    await moveFile(input.screenFilePath, outputPath);
  } else {
    // Non-native fallback — a raw, uncropped/unscaled getUserMedia recording of the
    // *whole* display (there's no way to crop at the capture source itself), transcoded
    // into the same shape a native capture already has: cropped to `areaRect` when given,
    // otherwise scaled/padded like a display capture — see native/screenCapture.ts's
    // `vfFor`, which the display/window branch here reuses so the two pipelines stay in
    // sync with each other.
    // `screenExt` names the container RecordingService's MediaRecorder actually produced
    // ("mp4" whenever H.264/MP4 was supported and preferred, "webm" otherwise) — only used
    // for the temp file's own extension here (ffmpeg demuxes by sniffing content, not by
    // extension, so this is a debugging nicety, not a correctness requirement). This still
    // always runs through transcodeScreenRecording regardless of source codec: the `-vf`
    // crop/scale/pad below is a real pixel transform, so there's no `-c copy` shortcut
    // available here even when the source is already H.264.
    const tempScreenPath = path.join(os.tmpdir(), `${id}-screen.${input.screenExt ?? "webm"}`);
    await fs.writeFile(tempScreenPath, Buffer.from(input.screenBytes!));
    cleanupPaths.push(tempScreenPath);
    const area = input.areaRect;
    const vf = area
      ? `crop=iw*${area.width}:ih*${area.height}:iw*${area.x}:ih*${area.y},${vfFor(true)}`
      : vfFor(false);
    console.log("[recording] transcoding fallback screen recording", { tempScreenPath, screenExt: input.screenExt, vf });
    try {
      await transcodeScreenRecording(tempScreenPath, outputPath, vf, onProgress, signal);
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
  if (input.screenFilePath || input.screenBytes) {
    const tempScreenPath = path.join(os.tmpdir(), `${id}-screen-final.mp4`);
    cleanupPaths.push(tempScreenPath);
    await resolveScreenTrack(id, input, tempScreenPath, onProgress, signal, cleanupPaths);

    if (!input.sideClip?.hasAudio) {
      await copyToMp4(tempScreenPath, finalMp4, onProgress, signal);
      return;
    }

    const audioPath = path.join(os.tmpdir(), `${id}-side.webm`);
    cleanupPaths.push(audioPath);
    await fs.writeFile(audioPath, Buffer.from(input.sideClip.bytes));
    await muxScreenWithAudio(tempScreenPath, audioPath, finalMp4, input.sideClipStartOffsetMs ?? 0, onProgress, signal);
    return;
  }

  const webmExt = input.webmExt ?? "webm";
  const tempClipPath = path.join(os.tmpdir(), `${id}.${webmExt}`);
  await fs.writeFile(tempClipPath, Buffer.from(input.webmBytes!));
  cleanupPaths.push(tempClipPath);
  if (webmExt === "mp4") {
    // MediaRecorder already produced real H.264/AAC — a plain container copy normalizes it
    // (same as the native-capture branch above), no re-encode needed.
    await copyToMp4(tempClipPath, finalMp4, onProgress, signal);
  } else {
    await remuxToMp4(tempClipPath, finalMp4, onProgress, signal);
  }
}

/** Lands the camera side clip in `metadata/` as what the editor will open as its camera
 *  track (see getEditProjectMedia, which resolves whichever extension actually exists).
 *
 *  A WebM clip is written verbatim: it's a self-contained Matroska stream and nothing
 *  downstream wants it changed. An MP4 one is not, and used to be — which is what made
 *  Advanced-mode camera video freeze a few seconds in while its audio kept playing.
 *  MediaRecorder hands back a *fragmented* MP4 (`ftyp moov moof mdat ... mfra`) whose
 *  `moov` carries no sample table and no real duration, so anything reading it has to walk
 *  the fragments to find frames at all. This was the one MediaRecorder output in the app
 *  that never saw an ffmpeg pass — Quick Recording's own mp4 goes through `copyToMp4`, the
 *  audio-only side clip through `convertToWav`, the non-native screen track through
 *  `transcodeScreenRecording` — and so the only one that reached a player still fragmented.
 *  `-c copy` rewrites those same already-encoded frames into an ordinary progressive mp4
 *  with a real `moov` index: no re-encode, hundreds of times realtime, and exactly the
 *  shape the editor's seek-driven preview and export path expect.
 *
 *  macOS additionally doesn't record H.264/MP4 for the camera at all any more (see
 *  RecordingService's isMacOS) — there the fragmented file was losing video outright rather
 *  than merely being awkward to index, which no amount of remuxing afterward can recover.
 *
 *  A failed ffmpeg pass falls back to the verbatim write it replaced: a fragmented camera
 *  track is a far better outcome than no camera track at all. */
async function writeCameraTrack(
  id: string,
  sideClip: SaveRecordingSideClip,
  metaDir: string,
  signal: AbortSignal,
  cleanupPaths: string[]
): Promise<void> {
  if (sideClip.ext !== "mp4") {
    await fs.writeFile(path.join(metaDir, `camera.${sideClip.ext}`), Buffer.from(sideClip.bytes));
    return;
  }

  const rawCameraPath = path.join(os.tmpdir(), `${id}-camera-raw.mp4`);
  cleanupPaths.push(rawCameraPath);
  await fs.writeFile(rawCameraPath, Buffer.from(sideClip.bytes));
  const cameraPath = path.join(metaDir, "camera.mp4");
  try {
    // No onProgress: the screen track's own pass drives the save-progress bar, and a second
    // reporter against the same id would only fight it for the same percentage.
    await copyToMp4(rawCameraPath, cameraPath, undefined, signal);
  } catch (e) {
    if (e instanceof FfmpegCancelledError) throw e;
    console.error("[recording] camera track normalize failed — writing raw MediaRecorder output", e);
    logNative(`[recording] camera normalize failed: id=${id} error=${String(e)}`);
    await fs.writeFile(cameraPath, Buffer.from(sideClip.bytes));
  }
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
    await resolveScreenTrack(id, input, path.join(metaDir, "screen.mp4"), onProgress, signal, cleanupPaths);

    if (input.sideClip?.hasVideo) {
      await writeCameraTrack(id, input.sideClip, metaDir, signal, cleanupPaths);
    } else if (input.sideClip) {
      // Audio-only side clip (mic/system audio, no camera video). RecordingService's
      // MediaRecorder always produces webm here (pickMimeType only tries H.264/MP4 for a
      // video-carrying stream), so it's converted to a real audio/wav file rather than kept
      // as webm — a plain PCM WAV is what the rest of the audio pipeline already expects for
      // camera-less audio (see registerRecordingIpc's saveAudio handler, which does the same
      // conversion for Meeting-tab audio-only recordings).
      const tempAudioPath = path.join(os.tmpdir(), `${id}-side-audio.${input.sideClip.ext}`);
      cleanupPaths.push(tempAudioPath);
      await fs.writeFile(tempAudioPath, Buffer.from(input.sideClip.bytes));
      await convertToWav(tempAudioPath, path.join(metaDir, "audio.wav"));
    }
  } else {
    // Camera-only capture — a single already-composited stream (see RecordingService's
    // stopCameraOnly), not a separate screen+camera pair. Landed straight into
    // metadata/screen.mp4 so getEditProjectMedia's single-file fallback still finds
    // something to edit, same as this mode's Quick-recording path — a plain container copy
    // when it's already H.264/MP4, a real transcode only when it's still VP9/WebM.
    const webmExt = input.webmExt ?? "webm";
    const tempClipPath = path.join(os.tmpdir(), `${id}.${webmExt}`);
    await fs.writeFile(tempClipPath, Buffer.from(input.webmBytes!));
    cleanupPaths.push(tempClipPath);
    const screenPath = path.join(metaDir, "screen.mp4");
    if (webmExt === "mp4") {
      await copyToMp4(tempClipPath, screenPath, onProgress, signal);
    } else {
      await remuxToMp4(tempClipPath, screenPath, onProgress, signal);
    }
  }

  await fs.writeFile(
    path.join(metaDir, "recordMeta.json"),
    JSON.stringify({
      overlay: input.overlay,
      cursorBakedIn: !!input.screenBytes,
      sideClipStartOffsetMs: input.sideClipStartOffsetMs ?? null,
    })
  );
}

async function finishRecordingSave(
  id: string,
  finalMp4: string,
  input: SaveRecordingInput,
  sender: IpcMainInvokeEvent["sender"],
  stopReceivedAt: number
): Promise<void> {
  const abort = new AbortController();
  pendingSaves.set(id, abort);
  const cleanupPaths: string[] = [];
  const recDir = path.dirname(finalMp4);
  const onProgress = (secondsDone: number) => {
    if (sender.isDestroyed() || input.durationSecs <= 0) return;
    const percent = Math.max(0, Math.min(99, Math.round((secondsDone / input.durationSecs) * 100)));
    sender.send(Channels.recording.saveProgress, { id, percent });
  };
  // "stopReceivedAt" is when the renderer's recording.save IPC call landed here, i.e. right
  // after RecordingService.stop() finished — so this timer covers the full recording-stop
  // -> source-finalized span the review asked to have logged, not just this function's own
  // work. Native Quick Recording is expected to land near-instant here (moveFile/-c copy,
  // no re-encode — see resolveScreenTrack/buildFinalMp4's own doc comments); a wildly larger
  // number for a native capture would itself be a signal something regressed.
  const logFinalizeBenchmark = async (finalizedPath: string, isEditProject: boolean) => {
    const elapsedMs = Date.now() - stopReceivedAt;
    let outputFileSizeBytes = 0;
    let outputDurationSecs = 0;
    try {
      outputFileSizeBytes = (await fs.stat(finalizedPath)).size;
    } catch {
      // Nothing to stat (shouldn't happen once we get here, but never fail the save over a
      // log line).
    }
    try {
      outputDurationSecs = await probeDuration(finalizedPath);
    } catch {
      // Same.
    }
    logNative(
      `[recording] finalize: id=${id} mode=${input.mode ?? "quick"} isEditProject=${isEditProject} ` +
        `nativeCapture=${!!input.screenFilePath} elapsedMs=${elapsedMs} outputFileSizeBytes=${outputFileSizeBytes} ` +
        `outputDurationSecs=${outputDurationSecs}`
    );
  };
  try {
    if (input.mode === "advanced") {
      await buildEditProjectMaterials(id, input, recDir, onProgress, abort.signal, cleanupPaths);
      await logFinalizeBenchmark(path.join(recDir, "metadata", "screen.mp4"), true);
      const project = createEditProject(input.title, { kind: "recording", recDir });
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
      await logFinalizeBenchmark(finalMp4, false);
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
    const stopReceivedAt = Date.now();
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
    void finishRecordingSave(id, finalMp4, input, event.sender, stopReceivedAt);

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
