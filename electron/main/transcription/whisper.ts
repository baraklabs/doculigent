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
import type { LlmModelProfile, Transcript } from "@shared/types/models";
import type { WhisperModelSize } from "@shared/constants/whisperModels";
import { getLlmProfile, getTranscriptionByokProfileId, getWhisperModel } from "../native/settingsStore";
import { getLlmApiKey } from "../native/keyring";
import { getWhisperModelStatuses, markDownloading, whisperCacheDir } from "./modelCache";
import { preloadModelInWorker, transcribeFileInWorker, transcribePcmInWorker } from "./whisperWorkerClient";
import { transcribeFileWithByok, transcribePcmWithByok } from "./byokClient";

/** Resolves a BYOK profile for transcription — re-validated against the live profile list
 *  (not just "an id is stored") since it could have been deleted, or had its "transcribe"
 *  capability unchecked, since it was picked (see MeetingPage.tsx's usingByok for the same
 *  check on the renderer side). Returns null rather than throwing so callers can fall back
 *  to the local Whisper path. `explicitId` lets a single call force a specific profile
 *  (e.g. Library's re-transcribe-with-a-different-model picker) instead of whichever one
 *  is globally selected in the Meeting tab (getTranscriptionByokProfileId). */
async function resolveByokProfile(explicitId?: string): Promise<{ profile: LlmModelProfile; apiKey: string | null } | null> {
  const id = explicitId ?? getTranscriptionByokProfileId();
  if (!id) return null;
  const profile = getLlmProfile(id);
  if (!profile || !profile.capabilities.includes("transcribe")) return null;
  const apiKey = profile.needsKey ? await getLlmApiKey(profile.id) : null;
  return { profile, apiKey };
}

/** Guards every transcription entry point below so nothing ever falls through to
 *  @huggingface/transformers' pipeline() with a model that isn't already on disk — that
 *  call downloads on demand by default, which is exactly the silent first-use download
 *  this app now avoids (model files only ever arrive via the explicit Settings >
 *  Transcription "Download" button, see modelCache.ts/whisper's preloadWhisperModel). */
function requireDownloadedModel(size: WhisperModelSize | null): WhisperModelSize {
  if (!size) {
    throw new Error("No transcription model is set up yet — go to Settings > Transcription to download one.");
  }
  const status = getWhisperModelStatuses().find((s) => s.size === size);
  // A download in progress writes its files incrementally, so "some bytes exist" alone
  // isn't enough — status.downloading (see modelCache.ts's markDownloading) rules out
  // treating a half-written model as usable.
  if (!status?.downloaded || status.downloading) {
    throw new Error(`The "${size}" transcription model isn't downloaded yet — go to Settings > Transcription to download it.`);
  }
  return size;
}

// Serializes preloadWhisperModel calls so clicking "Download" on several sizes in a row
// queues them instead of loading multiple ONNX sessions in the worker at once — that
// worker holds only one warm transcriber slot (see transcriptionWorker.ts's
// getTranscriber), and concurrent pipeline() loads for different multi-hundred-MB models
// were observed to exhaust the worker's memory/GPU resources and crash it outright,
// failing every download in flight (not just the newest one).
let preloadQueue: Promise<void> = Promise.resolve();

/** Forces a model's download/load to happen now rather than on the next live segment —
 *  backs the "Download" button in Settings > Transcription so a slow first-use download
 *  doesn't land in the middle of an actual meeting. Fetches both the multilingual and
 *  English-only variants for this size, since either can end up in use depending on the
 *  Meeting tab's language picker (see the worker's runWhisperOnSamples). Only one stays
 *  warm in the worker's memory afterward, but both are on disk, so switching between them
 *  later is a fast local reload rather than a fresh download.
 *
 *  Marks the size "downloading" (see modelCache.ts) for the whole queued+active duration,
 *  not just while it's actually loading, so Settings > Transcription shows "Downloading…"
 *  immediately on click even if an earlier download is still ahead of it in the queue. */
export function preloadWhisperModel(size: WhisperModelSize): Promise<void> {
  markDownloading(size, true);
  const run = preloadQueue
    .catch(() => {})
    .then(() => preloadModelInWorker(whisperCacheDir(), size))
    .finally(() => markDownloading(size, false));
  preloadQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** `modelSize`/`byokProfileId`: override the Settings > Transcription default for just
 *  this call (the Library transcript drawer's re-transcribe controls use these; nothing
 *  else does, so they stay optional). `byokProfileId` takes priority — an explicit BYOK
 *  choice always wins over an explicit local size, which in turn always wins over whatever
 *  is globally selected in the Meeting tab. */
export async function transcribeWithWhisper(
  videoPath: string,
  language?: string,
  modelSize?: WhisperModelSize,
  byokProfileId?: string
): Promise<Transcript> {
  if (byokProfileId) {
    const byok = await resolveByokProfile(byokProfileId);
    if (!byok) throw new Error("The selected BYOK model is no longer available — pick another in Settings.");
    return transcribeFileWithByok(videoPath, byok.profile, byok.apiKey, language);
  }
  if (!modelSize) {
    const byok = await resolveByokProfile();
    if (byok) return transcribeFileWithByok(videoPath, byok.profile, byok.apiKey, language);
  }
  const size = requireDownloadedModel(modelSize ?? getWhisperModel());
  return transcribeFileInWorker(whisperCacheDir(), videoPath, language, size);
}

/** Same pipeline, but for PCM samples the renderer already decoded and resampled to
 *  16kHz mono (see decodeToPcm16k in src/services/recording/AudioRecordingService.ts) —
 *  used by the Meeting tab's live transcription. Taking samples directly instead of raw
 *  webm bytes skips ffmpeg's process-spawn and temp-file round trip on every chunk, which
 *  matters here since it runs once per rolling segment rather than once per recording. */
export async function transcribePcm(samples: Float32Array, language?: string): Promise<Transcript> {
  const byok = await resolveByokProfile();
  if (byok) return transcribePcmWithByok(samples, byok.profile, byok.apiKey, language);
  const size = requireDownloadedModel(getWhisperModel());
  return transcribePcmInWorker(whisperCacheDir(), samples, language, size);
}
