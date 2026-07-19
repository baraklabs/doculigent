import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { CursorHighlightStyle } from "@shared/types/models";
import { applyCursorStyle, restoreCursor } from "../native/systemCursor";

export function registerCursorIpc(): void {
  ipcMain.handle(Channels.cursor.apply, async (_event, style: CursorHighlightStyle): Promise<void> => {
    applyCursorStyle(style);
  });

  ipcMain.handle(Channels.cursor.restore, async (): Promise<void> => {
    restoreCursor();
  });
}
