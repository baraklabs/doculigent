import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { AreaRect } from "@shared/types/models";
import { startScreenCapture, stopScreenCapture } from "../native/screenCapture";

export function registerScreenCaptureIpc(): void {
  ipcMain.handle(
    Channels.screenCapture.start,
    async (_event, targetId: string, hideCursor: boolean, area?: AreaRect): Promise<{ available: boolean }> => {
      const started = await startScreenCapture(targetId, hideCursor, area);
      return { available: started };
    }
  );

  ipcMain.handle(
    Channels.screenCapture.stop,
    async (): Promise<{ available: boolean; filePath?: string }> => {
      const filePath = await stopScreenCapture();
      return filePath ? { available: true, filePath } : { available: false };
    }
  );
}
