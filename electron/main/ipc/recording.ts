import { ipcMain, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Channels } from "@shared/constants/channels";
import type { OverlayConfig, Transcript, Video } from "@shared/types/models";
import { cameraBubbleRect, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";
import { ensureSaveDir } from "../native/paths";
import {
  convertToWav,
  copyToMp4,
  FfmpegCancelledError,
  muxScreenWithAudio,
  overlayCameraBubble,
  remuxToMp4,
} from "../native/ffmpeg";
import { insertVideo } from "../native/libraryStore";
import { writeCursorMetadata } from "../native/cursorTrack";
import { writeTranscriptFile } from "../native/transcriptFile";

/** A side clip recorded alongside a native (gdigrab) screen capture — see
 *  native/screenCapture.ts and RecordingService's gdigrab branch. `hasVideo` distinguishes
 *  a camera-bubble clip (overlaid onto the screen video) from a mic-only clip (just muxed
 *  in as audio); `hasAudio` is only meaningful when `hasVideo` is true, since a bubble clip
 *  can be silent (mic muted, camera still on). */
interface SideClip {
  bytes: ArrayBuffer;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface SaveRecordingInput {
  /** Full composited webm from the ordinary getUserMedia/MediaRecorder pipeline. Mutually
   *  exclusive with `screenFilePath` — exactly one is set, depending on which pipeline
   *  RecordingService used for this recording. */
  webmBytes?: ArrayBuffer;
  /** A screen video already written to disk by native/screenCapture.ts (gdigrab), with the
   *  real cursor excluded at capture time rather than drawn over afterward. */
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
  cursorHighlight: "default",
};

function recordingDir(saveDir: string, id: string): string {
  return path.join(saveDir, id);
}

const pendingSaves = new Map<string, AbortController>();

/** Produces `finalMp4` from `input`, picking the right ffmpeg step for whichever pipeline
 *  recorded it: a plain remux for the ordinary webm pipeline, or — for the gdigrab
 *  pipeline — a stream copy (screen only), an audio mux (screen + mic clip), or an overlay
 *  (screen + camera-bubble clip), so the fast no-camera/no-mic case never pays for a
 *  needless re-encode. */
async function buildFinalMp4(
  id: string,
  input: SaveRecordingInput,
  finalMp4: string,
  onProgress: (secondsDone: number) => void,
  signal: AbortSignal,
  cleanupPaths: string[]
): Promise<void> {
  if (input.screenFilePath) {
    cleanupPaths.push(input.screenFilePath);
    if (!input.sideClip) {
      await copyToMp4(input.screenFilePath, finalMp4, onProgress, signal);
      return;
    }

    const sideClipPath = path.join(os.tmpdir(), `${id}-side.webm`);
    await fs.writeFile(sideClipPath, Buffer.from(input.sideClip.bytes));
    cleanupPaths.push(sideClipPath);

    if (input.sideClip.hasVideo) {
      const { x, y } = cameraBubbleRect(input.overlay, OUTPUT_WIDTH, OUTPUT_HEIGHT);
      await overlayCameraBubble(
        input.screenFilePath,
        sideClipPath,
        { x, y },
        input.overlay.circular,
        input.sideClip.hasAudio,
        finalMp4,
        onProgress,
        signal
      );
    } else {
      await muxScreenWithAudio(input.screenFilePath, sideClipPath, finalMp4, onProgress, signal);
    }
    return;
  }

  const tempWebm = path.join(os.tmpdir(), `${id}.webm`);
  await fs.writeFile(tempWebm, Buffer.from(input.webmBytes!));
  cleanupPaths.push(tempWebm);
  await remuxToMp4(tempWebm, finalMp4, onProgress, signal);
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
      (secondsDone) => {
        if (sender.isDestroyed() || input.durationSecs <= 0) return;
        const percent = Math.max(0, Math.min(99, Math.round((secondsDone / input.durationSecs) * 100)));
        sender.send(Channels.recording.saveProgress, { id, percent });
      },
      abort.signal,
      cleanupPaths
    );
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
    // Written up front, next to the media rather than inside the app's own data dir, so
    // the cursor track travels with the recording the same way transcript.srt does.
    await writeCursorMetadata(id, recDir);
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
