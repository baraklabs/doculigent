/**
 * Message shapes exchanged between the main process (whisperWorkerClient.ts) and the
 * transcription UtilityProcess (transcriptionWorker.ts). Kept in its own file since both
 * sides import it — the worker side can't import anything that touches Electron's `app`
 * module, so this file (like the worker) must stay free of that too.
 */
import type { Transcript } from "@shared/types/models";
import type { WhisperModelSize } from "@shared/constants/whisperModels";

export type WorkerRequest =
  | { id: string; kind: "preload"; cacheDir: string; modelSize: WhisperModelSize }
  | {
      id: string;
      kind: "transcribeFile";
      cacheDir: string;
      filePath: string;
      language?: string;
      modelSize: WhisperModelSize;
    }
  | {
      id: string;
      kind: "transcribePcm";
      cacheDir: string;
      samples: Float32Array;
      language?: string;
      modelSize: WhisperModelSize;
    };

export type WorkerResponse =
  | { id: string; ok: true; transcript?: Transcript }
  | { id: string; ok: false; error: string };
