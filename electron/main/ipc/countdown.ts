import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import { closeCountdownWindow, forwardCountdownCancel, openCountdownWindow } from "../countdownWindow";

export function registerCountdownIpc(): void {
  ipcMain.handle(Channels.countdown.open, async (_event, secondsRemaining: number): Promise<void> => {
    openCountdownWindow(secondsRemaining);
  });

  ipcMain.handle(Channels.countdown.close, async (): Promise<void> => {
    closeCountdownWindow();
  });

  ipcMain.handle(Channels.countdown.cancel, async (): Promise<void> => {
    forwardCountdownCancel();
  });
}
