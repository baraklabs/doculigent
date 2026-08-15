import { desktopCapturer, ipcMain, shell, systemPreferences } from "electron";
import { Channels } from "@shared/constants/channels";
import type { CaptureTarget } from "@shared/types/models";

type PermissionStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export function registerCaptureIpc(): void {
  ipcMain.handle(Channels.capture.listTargets, async (): Promise<CaptureTarget[]> => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
    });
    return sources
      .filter((s) => s.name.trim().length > 0)
      .map(
        (s): CaptureTarget => ({
          id: s.id,
          title: s.name,
          kind: s.id.startsWith("screen:") ? "display" : "window",
          thumbnailDataUrl: s.thumbnail.isEmpty() ? undefined : s.thumbnail.toDataURL(),
        })
      );
  });

  ipcMain.handle(
    Channels.capture.getPermissionStatus,
    async (): Promise<{ screen: PermissionStatus; microphone: PermissionStatus }> => {
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
