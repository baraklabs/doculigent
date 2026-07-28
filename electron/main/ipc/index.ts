import { registerCaptureIpc } from "./capture";
import { registerCursorIpc } from "./cursor";
import { registerScreenCaptureIpc } from "./screenCapture";
import { registerAnnotationIpc } from "./annotation";
import { registerRecordingIpc } from "./recording";
import { registerLibraryIpc } from "./library";
import { registerEditProjectsIpc } from "./editProjects";
import { registerSettingsIpc } from "./settings";
import { registerAiIpc } from "./ai";
import { registerTranscriptionIpc } from "./transcription";
import { registerWindowIpc } from "./window";
import { registerAuthIpc } from "./auth";

export function registerIpcHandlers(): void {
  registerCaptureIpc();
  registerCursorIpc();
  registerScreenCaptureIpc();
  registerAnnotationIpc();
  registerRecordingIpc();
  registerLibraryIpc();
  registerEditProjectsIpc();
  registerSettingsIpc();
  registerAiIpc();
  registerTranscriptionIpc();
  registerWindowIpc();
  registerAuthIpc();
}
