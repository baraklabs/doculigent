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
      // Reads only — never askForMediaAccess here. This handler is polled on every
      // RecordPage mount/window-focus (react-query's refetchOnWindowFocus) and on every
      // RecordingService.start() call, so asking would re-trigger macOS's native mic TCC
      // prompt on each of those if mic permission is still "not-determined" — a modal
      // system dialog that steals all input to the app (including tab clicks) until
      // dismissed, and can render without an obvious visible cue. The mic permission
      // itself is already requested the standard way, once, via the renderer's own
      // getUserMedia({ audio }) calls (mic level meters, recording start, etc).
      const microphone = systemPreferences.getMediaAccessStatus("microphone") as PermissionStatus;
      return { screen, microphone };
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
