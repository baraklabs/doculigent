import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { Transcript } from "@shared/types/models";
import type { WhisperModelSize } from "@shared/constants/whisperModels";
import { transcribePcm, transcribeWithWhisper } from "../transcription/whisper";
import { terminateTranscriptionWorker } from "../transcription/whisperWorkerClient";

/** Real on-device transcription — see transcription/whisper.ts. Speaker diarization is
 *  still a gap (needs a separate model/pipeline, e.g. sherpa-onnx per FUNCTIONALITY.md
 *  §10) so every segment comes back attributed to one "Speaker" rather than faking turns. */
export function registerTranscriptionIpc(): void {
  ipcMain.handle(
    Channels.transcription.transcribe,
    async (_event, filePath: string, language?: string, modelSize?: WhisperModelSize): Promise<Transcript> => {
      return transcribeWithWhisper(filePath, language, modelSize);
    }
  );

  ipcMain.handle(
    Channels.transcription.transcribePcm,
    async (_event, samples: number[], language?: string): Promise<Transcript> => {
      return transcribePcm(Float32Array.from(samples), language);
    }
  );

  ipcMain.handle(Channels.transcription.cancel, async (): Promise<void> => {
    terminateTranscriptionWorker();
  });
}
