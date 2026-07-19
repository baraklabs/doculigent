/**
 * Public entry point for Whisper transcription from the rest of the main process
 * (ipc/transcription.ts, ipc/settings.ts). Actual model loading and inference runs in a
 * separate UtilityProcess (see transcriptionWorker.ts / whisperWorkerClient.ts) — never on
 * this (main) process.
 *
 * Before this split, all of that ran directly here: @huggingface/transformers' ONNX Runtime
 * inference is CPU-bound work that isn't yielded back to Node piecemeal, so a chunk taking
 * even a couple of seconds blocked ipcMain from answering *any* other request (recording
 * start/stop, library actions, settings) for that whole window — that's what showed up as
 * app-wide UI freezes during transcription. A UtilityProcess has its own event loop, so no
 * amount of inference time there can stall this process or the renderer.
 *
 * This app is fully on-device/local-first (same reasoning as the Settings page defaulting
 * to Ollama for chat/summarize) — no network calls, no API key, no Python subprocess
 * either; @huggingface/transformers runs Whisper via ONNX Runtime's native Node bindings,
 * using a GPU execution provider automatically when one is available (DirectML on
 * Windows, CUDA on Linux, CoreML on macOS — see transcriptionWorker.ts's getTranscriber),
 * falling back to CPU otherwise.
 *
 * No speaker diarization in this pass — that's a separate model/pipeline (e.g.
 * sherpa-onnx per FUNCTIONALITY.md §10) and out of scope here; every segment is
 * attributed to one "Speaker" rather than faking turn detection.
 */
import type { Transcript } from "@shared/types/models";
import type { WhisperModelSize } from "@shared/constants/whisperModels";
import { getWhisperModel } from "../native/settingsStore";
import { whisperCacheDir } from "./modelCache";
import { preloadModelInWorker, transcribeFileInWorker, transcribePcmInWorker } from "./whisperWorkerClient";

/** Forces a model's download/load to happen now rather than on the next live segment —
 *  backs the "Download" button in Settings > Transcription so a slow first-use download
 *  doesn't land in the middle of an actual meeting. Fetches both the multilingual and
 *  English-only variants for this size, since either can end up in use depending on the
 *  Meeting tab's language picker (see the worker's runWhisperOnSamples). Only one stays
 *  warm in the worker's memory afterward, but both are on disk, so switching between them
 *  later is a fast local reload rather than a fresh download. */
export async function preloadWhisperModel(size: WhisperModelSize): Promise<void> {
  await preloadModelInWorker(whisperCacheDir(), size);
}

/** `modelSize`: overrides the Settings > Transcription default for just this call (the
 *  Library transcript drawer's re-transcribe controls use this; nothing else does, so it
 *  stays optional). */
export async function transcribeWithWhisper(
  videoPath: string,
  language?: string,
  modelSize?: WhisperModelSize
): Promise<Transcript> {
  return transcribeFileInWorker(whisperCacheDir(), videoPath, language, modelSize ?? getWhisperModel());
}

/** Same pipeline, but for PCM samples the renderer already decoded and resampled to
 *  16kHz mono (see decodeToPcm16k in src/services/recording/AudioRecordingService.ts) —
 *  used by the Meeting tab's live transcription. Taking samples directly instead of raw
 *  webm bytes skips ffmpeg's process-spawn and temp-file round trip on every chunk, which
 *  matters here since it runs once per rolling segment rather than once per recording. */
export async function transcribePcm(samples: Float32Array, language?: string): Promise<Transcript> {
  return transcribePcmInWorker(whisperCacheDir(), samples, language, getWhisperModel());
}
