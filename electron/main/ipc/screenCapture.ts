import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import { startScreenCapture, stopScreenCapture } from "../native/screenCapture";

export function registerScreenCaptureIpc(): void {
  ipcMain.handle(
    Channels.screenCapture.start,
    async (_event, targetId: string, hideCursor: boolean): Promise<{ available: boolean }> => {
      const started = await startScreenCapture(targetId, hideCursor);
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
