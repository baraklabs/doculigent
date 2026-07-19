import { desktopCapturer, ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { CaptureTarget } from "@shared/types/models";

export function registerCaptureIpc(): void {
  ipcMain.handle(Channels.capture.listTargets, async (): Promise<CaptureTarget[]> => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
    return sources
      .filter((s) => s.name.trim().length > 0)
      .map(
        (s): CaptureTarget => ({
          // Electron's own source id (e.g. "screen:0:0" / "window:1234:0") is used
          // directly as the target id: RecordingService passes it straight through as
          // `chromeMediaSourceId` to getUserMedia, so no separate id-lookup table is
          // needed between "what the picker shows" and "what capture actually uses".
          id: s.id,
          title: s.name,
          kind: s.id.startsWith("screen:") ? "display" : "window",
        })
      );
  });
}
