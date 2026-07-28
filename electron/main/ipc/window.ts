import { BrowserWindow, ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import { toggleMaximize } from "../window";
export function registerWindowIpc(): void {
  ipcMain.handle(Channels.window.minimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle(Channels.window.close, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle(Channels.window.toggleMaximize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? toggleMaximize(win) : false;
  });

  ipcMain.handle(Channels.window.isMaximized, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
}
