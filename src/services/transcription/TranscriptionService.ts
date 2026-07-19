import type { Transcript } from "@shared/types/models";
import type { WhisperModelSize } from "@shared/constants/whisperModels";

/** See electron/main/transcription/whisper.ts — real on-device transcription via
 *  @huggingface/transformers, no network calls after the one-time model download. No
 *  speaker diarization yet (separate model/pipeline, future work). */
export const TranscriptionService = {
  /** `modelSize` overrides the Settings > Transcription default for just this call — used
   *  by the Library transcript drawer's re-transcribe controls. */
  transcribe(filePath: string, language?: string, modelSize?: WhisperModelSize): Promise<Transcript> {
    return window.api.transcription.transcribe(filePath, language, modelSize);
  },
  /** Transcribes one already-decoded 16kHz mono PCM chunk — used for the Meeting tab's
   *  live transcript (see decodeToPcm16k in AudioRecordingService.ts for the decode step). */
  transcribePcm(samples: Float32Array, language?: string): Promise<Transcript> {
    return window.api.transcription.transcribePcm(Array.from(samples), language);
  },
  /** Stops whatever transcription is currently running — the in-flight transcribe()/
   *  transcribePcm() call rejects as a result (see whisper.ts's worker-exit handling). */
  cancel(): Promise<void> {
    return window.api.transcription.cancel();
  },
};
