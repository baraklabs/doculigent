import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { AreaRect } from "@shared/types/models";
import { startCursorTrack, stopCursorTrack } from "../native/cursorTrack";

export function registerCursorIpc(): void {
  ipcMain.handle(
    Channels.cursor.startCapture,
    async (_event, targetId: string, area?: AreaRect | null): Promise<void> => {
      await startCursorTrack(targetId, area ?? null);
    }
  );

  ipcMain.handle(Channels.cursor.stopCapture, async (): Promise<void> => {
    stopCursorTrack();
  });
}
