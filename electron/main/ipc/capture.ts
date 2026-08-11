import { desktopCapturer, ipcMain, shell, systemPreferences } from "electron";
import { Channels } from "@shared/constants/channels";
import type { CaptureTarget } from "@shared/types/models";

type PermissionStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

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

  ipcMain.handle(
    Channels.capture.getPermissionStatus,
    async (): Promise<{ screen: PermissionStatus; microphone: PermissionStatus }> => {
      // Screen Recording access can't be requested programmatically on macOS — only
      // checked. Microphone access can be prompted for directly, so we do that here
      // rather than just reporting status, since asking is a no-op once decided.
      if (process.platform !== "darwin") {
        return { screen: "granted", microphone: "granted" };
      }
      const screen = systemPreferences.getMediaAccessStatus("screen") as PermissionStatus;
      const micGranted = await systemPreferences.askForMediaAccess("microphone");
      return { screen, microphone: micGranted ? "granted" : "denied" };
    }
  );

  ipcMain.handle(Channels.capture.openScreenRecordingSettings, async (): Promise<void> => {
    if (process.platform !== "darwin") return;
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  });
}
