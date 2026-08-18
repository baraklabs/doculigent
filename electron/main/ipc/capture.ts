import { desktopCapturer, ipcMain, shell, systemPreferences } from "electron";
import { Channels } from "@shared/constants/channels";
import type { CaptureTarget } from "@shared/types/models";
import { setPendingDisplayMediaTarget } from "../displayMedia";

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

  // Input Monitoring — needed for native/cursorIcon.ts's macOS click polling (drives
  // Timeline's "auto zoom on clicks"). Unlike Screen Recording, Electron has no API to
  // check this permission's status, so there's no equivalent getPermissionStatus() for
  // it — this just opens the settings pane on request.
  ipcMain.handle(Channels.capture.openInputMonitoringSettings, async (): Promise<void> => {
    if (process.platform !== "darwin") return;
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent");
  });

  ipcMain.handle(Channels.capture.setDisplayMediaTarget, async (_event, targetId: string | null): Promise<void> => {
    setPendingDisplayMediaTarget(targetId);
  });
}
