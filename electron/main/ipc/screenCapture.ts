import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { AreaRect } from "@shared/types/models";
import {
  captureStartedAt,
  discardScreenCapture,
  isCaptureContentProtected,
  pauseScreenCapture,
  resumeScreenCapture,
  startScreenCapture,
  stopScreenCapture,
} from "../native/screenCapture";

export function registerScreenCaptureIpc(): void {
  ipcMain.handle(
    Channels.screenCapture.start,
    async (
      _event,
      targetId: string,
      hideCursor: boolean,
      area?: AreaRect,
      mode?: "quick" | "advanced"
    ): Promise<{ available: boolean; contentProtected: boolean; startedAtMs: number | null }> => {
      const started = await startScreenCapture(targetId, hideCursor, area, mode);
      return {
        available: started,
        contentProtected: started && isCaptureContentProtected(),
        // The renderer uses this (RecordingService.screenStartedAtMs) as the wall-clock
        // origin for the side clip's own start offset — see
        // EditProjectMedia.sideClipStartOffsetMs. Same Date.now() clock as the main
        // process's own capture clock (native/screenCapture.ts), so it's directly
        // comparable to a Date.now() taken later in the renderer.
        startedAtMs: started ? captureStartedAt() : null,
      };
    }
  );

  ipcMain.handle(
    Channels.screenCapture.stop,
    async (): Promise<{ available: boolean; filePath?: string }> => {
      const filePath = await stopScreenCapture();
      return filePath ? { available: true, filePath } : { available: false };
    }
  );

  ipcMain.handle(Channels.screenCapture.pause, async (): Promise<boolean> => pauseScreenCapture());
  ipcMain.handle(Channels.screenCapture.resume, async (): Promise<boolean> => resumeScreenCapture());
  ipcMain.handle(Channels.screenCapture.discard, async (): Promise<void> => discardScreenCapture());
}
