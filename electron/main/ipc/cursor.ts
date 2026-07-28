import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { CursorHighlightStyle } from "@shared/types/models";
import { applyCursorStyle, restoreCursor } from "../native/systemCursor";
import { startCursorTrack, stopCursorTrack } from "../native/cursorTrack";

export function registerCursorIpc(): void {
  ipcMain.handle(Channels.cursor.apply, async (_event, style: CursorHighlightStyle): Promise<void> => {
    applyCursorStyle(style);
  });

  ipcMain.handle(Channels.cursor.restore, async (): Promise<void> => {
    restoreCursor();
  });

  ipcMain.handle(
    Channels.cursor.startCapture,
    async (_event, targetId: string, style: CursorHighlightStyle): Promise<void> => {
      await startCursorTrack(targetId, style);
    }
  );

  // The samples stay buffered in the main process until recording:save knows where the
  // recording folder is — the renderer never has to carry them.
  ipcMain.handle(Channels.cursor.stopCapture, async (): Promise<void> => {
    stopCursorTrack();
  });
}
