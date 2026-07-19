import { BrowserWindow, ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";

/** Backs the custom topbar's minimize/close buttons — the window is frameless (see
 *  electron/main/window.ts), so there's no native title bar to provide these. */
export function registerWindowIpc(): void {
  ipcMain.handle(Channels.window.minimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle(Channels.window.close, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}
