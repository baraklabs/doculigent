import { ipcMain, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Channels } from "@shared/constants/channels";
import type { OverlayConfig, Transcript, Video } from "@shared/types/models";
import { ensureSaveDir } from "../native/paths";
import { convertToWav, remuxToMp4 } from "../native/ffmpeg";
import { insertVideo } from "../native/db";
import { writeTranscriptFile } from "../native/transcriptFile";

interface SaveRecordingInput {
  webmBytes: ArrayBuffer;
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

// Meeting audio recordings have no camera bubble — this is just filler to satisfy the
// shared Video/OverlayConfig shape, never rendered for an audio-only entry.
const AUDIO_OVERLAY: OverlayConfig = {
  corner: "bottom-right",
  sizePct: 0,
  circular: false,
  showCamera: false,
  cameraDeviceId: null,
  cursorHighlight: "default",
};

/** Every recording gets its own `saveDir/{id}/` folder — the media file, and (once
 *  transcribed) transcript.srt, live side by side rather than as a flat pile of files
 *  sharing one directory. */
function recordingDir(saveDir: string, id: string): string {
  return path.join(saveDir, id);
}

/** The MP4 remux (see ffmpeg.ts) is a real re-encode, not a fast container-only copy —
 *  it takes real time proportional to the recording's length. Blocking the Stop button
 *  on it made stopping feel like it hung, so `recording.save` now resolves as soon as the
 *  (fast) webm write is done, and this runs the (slow) transcode + library insert
 *  afterward, pushing the result back once it's actually ready. Any window still open by
 *  then picks it up; if the app quits first, this in-flight save is simply interrupted
 *  (same as any other background job killed by process exit) — not attempting
 *  crash-resilient resume-on-next-launch, which is a different, bigger feature. */
async function finishRecordingSave(
  id: string,
  tempWebm: string,
  finalMp4: string,
  input: SaveRecordingInput,
  sender: IpcMainInvokeEvent["sender"]
): Promise<void> {
  try {
    await remuxToMp4(tempWebm, finalMp4);
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
    if (!sender.isDestroyed()) sender.send(Channels.recording.saveFailed, { id, message: String(e) });
  } finally {
    await fs.rm(tempWebm, { force: true });
  }
}

export function registerRecordingIpc(): void {
  ipcMain.handle(Channels.recording.save, async (event, input: SaveRecordingInput): Promise<{ id: string }> => {
    const saveDir = ensureSaveDir();
    const id = randomUUID();
    const recDir = recordingDir(saveDir, id);
    await fs.mkdir(recDir, { recursive: true });
    const tempWebm = path.join(os.tmpdir(), `${id}.webm`);
    const finalMp4 = path.join(recDir, "recording.mp4");

    // Only the (fast) write is awaited here — the (slow) transcode + library insert
    // happens in the background; see finishRecordingSave's doc comment above.
    await fs.writeFile(tempWebm, Buffer.from(input.webmBytes));
    void finishRecordingSave(id, tempWebm, finalMp4, input, event.sender);

    return { id };
  });

  ipcMain.handle(Channels.recording.saveAudio, async (_event, input: SaveAudioInput): Promise<Video> => {
    // WAV (uncompressed PCM) rather than the original compressed WebM/Opus, for
    // universal compatibility with audio tools — meaningfully bigger on disk, but the
    // conversion itself is fast (audio-only), so this stays a normal blocking save
    // unlike recording.save above.
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
    // The Meeting tab transcribes live during the call, so (unlike a video, which only
    // gets transcribed later from the Library) the transcript can already be here.
    if (input.transcript) await writeTranscriptFile(finalWav, input.transcript);
    return video;
  });
}
