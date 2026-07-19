/**
 * Owns the lifecycle of the UtilityProcess that all Whisper inference actually runs in
 * (see transcriptionWorker.ts) — forked lazily on first use, kept alive across calls so
 * the loaded model stays warm, and re-forked automatically if it ever crashes. whisper.ts
 * wraps this with the same function signatures the rest of the app already calls, so
 * ipc/transcription.ts and ipc/settings.ts needed no changes.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { utilityProcess } from "electron";
import type { Transcript } from "@shared/types/models";
import type { WhisperModelSize } from "@shared/constants/whisperModels";
import type { WorkerRequest, WorkerResponse } from "./workerMessages";

type Pending = { resolve: (transcript: Transcript | undefined) => void; reject: (error: Error) => void };

let child: ReturnType<typeof utilityProcess.fork> | null = null;
const pending = new Map<string, Pending>();

// Where transcriptionWorker.js lives at runtime — always out/main, next to index.js (see
// electron.vite.config.ts's second "main" entry). Set once via initTranscriptionWorkerClient
// below. Deliberately NOT derived from this module's own __dirname (Rollup can hoist a
// module shared by multiple entries into a separate out/main/chunks/ file, so this file's
// own compiled location isn't guaranteed to be out/main), nor from app.getAppPath() or
// require.main (both were tried and found unreliable: getAppPath() doesn't resolve to the
// project root when Electron is launched directly against a built script path rather than
// via `electron .`, and require.main is simply undefined in Electron's main process).
// electron/main/index.ts is the one file Rollup can never relocate — it IS the entry
// chunk — so its own __dirname is the only value guaranteed correct in every launch mode.
let mainDir: string | null = null;

export function initTranscriptionWorkerClient(entryDir: string): void {
  mainDir = entryDir;
}

function ensureWorker(): ReturnType<typeof utilityProcess.fork> {
  if (child) return child;
  if (!mainDir) {
    throw new Error("initTranscriptionWorkerClient() must be called (from electron/main/index.ts) before transcription is used");
  }

  const modulePath = path.join(mainDir, "transcriptionWorker.js");
  const proc = utilityProcess.fork(modulePath, [], { stdio: "pipe" });
  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[whisper-worker] ${d}`));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[whisper-worker] ${d}`));

  proc.on("message", (message: WorkerResponse) => {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.ok) waiting.resolve(message.transcript);
    else waiting.reject(new Error(message.error));
  });

  proc.on("exit", (code) => {
    child = null;
    const err = new Error(`Transcription worker exited unexpectedly (code ${code})`);
    for (const waiting of pending.values()) waiting.reject(err);
    pending.clear();
  });

  child = proc;
  return proc;
}

function send(req: WorkerRequest): Promise<Transcript | undefined> {
  const proc = ensureWorker();
  return new Promise((resolve, reject) => {
    pending.set(req.id, { resolve, reject });
    proc.postMessage(req);
  });
}

export async function preloadModelInWorker(cacheDir: string, modelSize: WhisperModelSize): Promise<void> {
  await send({ id: randomUUID(), kind: "preload", cacheDir, modelSize });
}

export async function transcribeFileInWorker(
  cacheDir: string,
  filePath: string,
  language: string | undefined,
  modelSize: WhisperModelSize
): Promise<Transcript> {
  const transcript = await send({ id: randomUUID(), kind: "transcribeFile", cacheDir, filePath, language, modelSize });
  return transcript as Transcript;
}

export async function transcribePcmInWorker(
  cacheDir: string,
  samples: Float32Array,
  language: string | undefined,
  modelSize: WhisperModelSize
): Promise<Transcript> {
  const transcript = await send({ id: randomUUID(), kind: "transcribePcm", cacheDir, samples, language, modelSize });
  return transcript as Transcript;
}

/** Called on app quit (see electron/main/index.ts's before-quit) — an orphaned utility
 *  process holding a loaded ONNX model in memory has no reason to outlive the app. */
export function terminateTranscriptionWorker(): void {
  child?.kill();
  child = null;
}
