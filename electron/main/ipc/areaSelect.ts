import { BrowserWindow, ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { AreaRect } from "@shared/types/models";
import { activateAreaSelectWindow, cancelAreaSelect, completeAreaSelect, openAreaSelectOverlay } from "../areaSelectWindow";

export function registerAreaSelectIpc(): void {
  ipcMain.handle(Channels.areaSelect.open, async (): Promise<void> => {
    await openAreaSelectOverlay();
  });

  ipcMain.handle(Channels.areaSelect.activate, async (event): Promise<void> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) activateAreaSelectWindow(win);
  });

  ipcMain.handle(Channels.areaSelect.complete, async (_event, targetId: string, rect: AreaRect): Promise<void> => {
    completeAreaSelect(targetId, rect);
  });

  ipcMain.handle(Channels.areaSelect.cancel, async (): Promise<void> => {
    cancelAreaSelect();
  });
}
