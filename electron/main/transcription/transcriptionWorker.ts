/**
 * Runs inside an Electron UtilityProcess forked by whisperWorkerClient.ts — this is where
 * @huggingface/transformers model loading and actual Whisper inference happen, entirely
 * off the main process. Previously this logic lived directly in whisper.ts and ran on the
 * main process's own event loop: ONNX Runtime inference is CPU-bound work that isn't
 * yielded piecemeal back to Node, so a single transcription call blocked ipcMain from
 * answering *any* other request (recording start/stop, library actions, settings) for the
 * whole time it ran, which is what showed up as app-wide UI freezes. A UtilityProcess has
 * its own process/event loop, so no amount of inference time here can stall the main
 * process or the renderer.
 *
 * This file cannot import anything that touches Electron's `app` module (userData paths,
 * settings) — that's main-process-only and unavailable here. The client resolves
 * cacheDir/modelSize in the main process and sends them explicitly in every request
 * instead.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpegStaticPath from "ffmpeg-static";
import type { Transcript, TranscriptSegment } from "@shared/types/models";
import { whisperModelHfId, whisperModelHfIdEn, whisperModelHasEnglishVariant } from "@shared/constants/whisperModels";
import type { WhisperModelSize } from "@shared/constants/whisperModels";
import type { WorkerRequest, WorkerResponse } from "./workerMessages";

// Same asar-unpack path rewrite as native/ffmpeg.ts — ffmpeg-static's binary can't run
// straight out of a packaged app's asar archive.
const ffmpegPath = (ffmpegStaticPath ?? "ffmpeg").replace("app.asar", "app.asar.unpacked");

function extractMonoWav(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", "-f", "wav", outputPath]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg audio extraction failed (${code}): ${stderr.slice(-2000)}`));
    });
  });
}

/** Minimal PCM16 mono WAV reader — sufficient for the fixed format `extractMonoWav`
 *  above always produces, so this skips being a general-purpose WAV parser. */
async function readPcm16Wav(filePath: string): Promise<Float32Array> {
  const buf = await fs.readFile(filePath);
  let offset = 12; // past the RIFF/WAVE header
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataOffset < 0) throw new Error("Could not find a data chunk in the extracted WAV audio");

  const sampleCount = Math.floor(dataSize / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return samples;
}

interface WhisperChunk {
  text: string;
  timestamp: [number, number | null];
}

interface WhisperTranscriber {
  (audio: Float32Array, options: Record<string, unknown>): Promise<{ text: string; chunks?: WhisperChunk[] }>;
}

let transcriberPromise: Promise<WhisperTranscriber> | null = null;
let transcriberModelId: string | null = null;

// 'q8' (int8 dynamic quantization) keeps downloads/memory small and matches what this
// app has always advertised in Settings ("the quantized ONNX weights", see
// shared/constants/whisperModels.ts) — @huggingface/transformers defaults to full fp32
// on cpu/gpu devices (only 'wasm' defaults to quantized), which would silently balloon
// every download several-fold (e.g. large-v3 fp32 is ~13GB vs. ~1.6GB quantized) if left
// unspecified.
const MODEL_DTYPE = "q8";

/** First call for a given model id downloads + caches it from Hugging Face; every call
 *  after that is instant. Re-resolves (and reloads) if the requested model id changes
 *  between calls — otherwise cached for this worker process's lifetime.
 *
 *  Tries GPU execution first ('auto' picks the best available per-platform provider —
 *  DirectML on Windows, CUDA on Linux, CoreML on macOS — then WebGPU, then CPU, all
 *  within one session so ONNX Runtime can fall back internally). If session creation
 *  still throws outright (e.g. no compatible GPU driver at all), falls back to an
 *  explicit CPU-only load as a last resort, so a machine with no usable GPU never fails
 *  to transcribe — it just runs slower. */
function getTranscriber(modelId: string, cacheDir: string): Promise<WhisperTranscriber> {
  if (!transcriberPromise || transcriberModelId !== modelId) {
    transcriberModelId = modelId;
    transcriberPromise = import("@huggingface/transformers").then(async ({ pipeline, env }) => {
      env.cacheDir = cacheDir;
      try {
        const transcriber = await pipeline("automatic-speech-recognition", modelId, {
          device: "auto",
          dtype: MODEL_DTYPE,
        });
        return transcriber as unknown as WhisperTranscriber;
      } catch (err) {
        console.warn(`[whisper-worker] GPU-accelerated load failed for "${modelId}", falling back to CPU:`, err);
        const transcriber = await pipeline("automatic-speech-recognition", modelId, {
          device: "cpu",
          dtype: MODEL_DTYPE,
        });
        return transcriber as unknown as WhisperTranscriber;
      }
    });
  }
  return transcriberPromise;
}

// The transcriber above is a single shared model/session instance. The Meeting tab's live
// transcription fires one call per rolling chunk, which can arrive faster than a previous
// chunk finishes processing — running the shared session concurrently from overlapping
// calls isn't documented as safe by @huggingface/transformers, so calls are serialized here
// rather than risking subtly-wrong results from overlapping inference. The (I/O-bound)
// ffmpeg extraction before this isn't queued, so that part still parallelizes freely
// across chunks — only the actual model call is serialized.
let transcriptionQueue: Promise<unknown> = Promise.resolve();
function runTranscriberQueued(
  transcriber: WhisperTranscriber,
  samples: Float32Array,
  options: Record<string, unknown>
): ReturnType<WhisperTranscriber> {
  const result = transcriptionQueue.then(() => transcriber(samples, options));
  transcriptionQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Energy-based voice-activity gate for the live per-segment path only (transcribePcm
 *  below) — Whisper is a well-documented hallucinator on near-silent audio, fabricating
 *  fixed phrases ("Thank you.", "Subtitles by...") instead of returning nothing. The
 *  Meeting tab's 4s rolling segments are silence more often than not (gaps between
 *  sentences, muted mic), so this is the single biggest source of garbage live captions.
 *  Skipping the model call outright below this floor removes the failure mode instead of
 *  trying to filter bad text after the fact. -44 dBFS is comfortably above typical mic
 *  noise floor but below even quiet speech, so real speech isn't at risk of being gated.
 *
 *  Deliberately NOT applied to the full-recording path (transcribeFile) — a 30s chunk
 *  there can legitimately contain quiet speech next to louder parts, so a whole-chunk
 *  energy gate would risk dropping real words rather than just silence. */
const SILENCE_RMS_THRESHOLD = 0.006; // ~ -44 dBFS

function isEffectivelySilent(samples: Float32Array): boolean {
  if (samples.length === 0) return true;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms < SILENCE_RMS_THRESHOLD;
}

/** "auto" (or omitted) lets Whisper detect the spoken language itself; anything else
 *  forces decoding into that language, matching the Meeting tab's language picker.
 *
 *  English specifically uses the "*.en" model variant rather than forcing the language
 *  token on the multilingual one — .en models are English-only/single-task, so they have
 *  no language or task tokens in their vocabulary at all; passing either would throw
 *  ("Unable to find language/task ... in model vocabulary"), so those options are only
 *  ever sent when actually using the multilingual model. large-v3 and turbo have no .en
 *  checkpoint at all (whisperModelHasEnglishVariant is false for both), so those sizes
 *  always go through the multilingual path even when "en" is requested — same as forcing
 *  any other language. */
async function runWhisperOnSamples(
  cacheDir: string,
  samples: Float32Array,
  timestamps: boolean,
  language: string | undefined,
  modelSize: WhisperModelSize
): Promise<Transcript> {
  const useEnglishOnly = language === "en" && whisperModelHasEnglishVariant(modelSize);
  const transcriber = await getTranscriber(
    useEnglishOnly ? whisperModelHfIdEn(modelSize) : whisperModelHfId(modelSize),
    cacheDir
  );
  const forcedLanguage = !useEnglishOnly && language && language !== "auto" ? language : undefined;

  // return_timestamps adds real per-token decoding overhead for sub-segment timing we
  // don't need on the live-chunk path (transcribePcm) — the chunk's own known start/end
  // from the JS side is good enough for a chat-style live feed, so that path skips it for
  // speed. The full-recording path (transcribeFile) still wants real per-segment
  // timestamps for the transcript drawer's scrubbing/display.
  const callOptions: Record<string, unknown> = {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: timestamps,
  };
  if (forcedLanguage) {
    callOptions.language = forcedLanguage;
    callOptions.task = "transcribe";
  }
  const result = await runTranscriberQueued(transcriber, samples, callOptions);

  const chunks: WhisperChunk[] = result.chunks?.length
    ? result.chunks
    : [{ text: result.text, timestamp: [0, samples.length / 16000] }];

  const segments: TranscriptSegment[] = chunks
    .map((c) => ({
      start: c.timestamp[0] ?? 0,
      end: c.timestamp[1] ?? c.timestamp[0] ?? 0,
      speaker: "Speaker",
      text: c.text.trim(),
    }))
    .filter((s) => s.text.length > 0);

  return { language: useEnglishOnly ? "en" : (forcedLanguage ?? "auto"), engine: "whisper-local", segments };
}

async function transcribeFile(
  cacheDir: string,
  videoPath: string,
  language: string | undefined,
  modelSize: WhisperModelSize
): Promise<Transcript> {
  const tmpWav = path.join(os.tmpdir(), `${randomUUID()}.wav`);
  await extractMonoWav(videoPath, tmpWav);
  try {
    const samples = await readPcm16Wav(tmpWav);
    return await runWhisperOnSamples(cacheDir, samples, true, language, modelSize);
  } finally {
    await fs.rm(tmpWav, { force: true });
  }
}

async function transcribePcm(
  cacheDir: string,
  samples: Float32Array,
  language: string | undefined,
  modelSize: WhisperModelSize
): Promise<Transcript> {
  if (isEffectivelySilent(samples)) {
    return { language: language && language !== "auto" ? language : "auto", engine: "whisper-local", segments: [] };
  }
  return runWhisperOnSamples(cacheDir, samples, false, language, modelSize);
}

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  try {
    if (req.kind === "preload") {
      await getTranscriber(whisperModelHfId(req.modelSize), req.cacheDir);
      if (whisperModelHasEnglishVariant(req.modelSize)) {
        await getTranscriber(whisperModelHfIdEn(req.modelSize), req.cacheDir);
      }
      return { id: req.id, ok: true };
    }
    if (req.kind === "transcribeFile") {
      const transcript = await transcribeFile(req.cacheDir, req.filePath, req.language, req.modelSize);
      return { id: req.id, ok: true, transcript };
    }
    const transcript = await transcribePcm(req.cacheDir, req.samples, req.language, req.modelSize);
    return { id: req.id, ok: true, transcript };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

process.parentPort.on("message", (event) => {
  const req = event.data as WorkerRequest;
  handle(req).then((response) => process.parentPort.postMessage(response));
});
