import { registerCaptureIpc } from "./capture";
import { registerCursorIpc } from "./cursor";
import { registerAnnotationIpc } from "./annotation";
import { registerRecordingIpc } from "./recording";
import { registerLibraryIpc } from "./library";
import { registerSettingsIpc } from "./settings";
import { registerAiIpc } from "./ai";
import { registerTranscriptionIpc } from "./transcription";
import { registerWindowIpc } from "./window";
import { registerAuthIpc } from "./auth";

export function registerIpcHandlers(): void {
  registerCaptureIpc();
  registerCursorIpc();
  registerAnnotationIpc();
  registerRecordingIpc();
  registerLibraryIpc();
  registerSettingsIpc();
  registerAiIpc();
  registerTranscriptionIpc();
  registerWindowIpc();
  registerAuthIpc();
}
