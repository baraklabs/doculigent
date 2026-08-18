import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type {
  RecordingDockAction,
  RecordingDockBounds,
  RecordingDockConfig,
  RecordingDockOrientation,
  RecordingDockTimerSync,
} from "@shared/types/models";
import {
  closeRecordingDockWindow,
  forwardRecordingDockAction,
  forwardRecordingDockTimerSync,
  getRecordingDockBounds,
  getRecordingDockConfig,
  getRecordingDockTimerSync,
  hideMainWindowForDock,
  isMainWindowVisibleForDock,
  openRecordingDockWindow,
  setRecordingDockBounds,
  setRecordingDockOrientation,
  showMainWindowForDock,
} from "../recordingDockWindow";

export function registerRecordingDockIpc(): void {
  ipcMain.handle(Channels.recordingDock.open, async (): Promise<void> => {
    openRecordingDockWindow();
  });

  ipcMain.handle(Channels.recordingDock.close, async (): Promise<void> => {
    closeRecordingDockWindow();
  });

  ipcMain.handle(
    Channels.recordingDock.setOrientation,
    async (_event, orientation: RecordingDockOrientation): Promise<void> => {
      setRecordingDockOrientation(orientation);
    }
  );

  ipcMain.handle(Channels.recordingDock.getConfig, async (): Promise<RecordingDockConfig> => getRecordingDockConfig());

  ipcMain.handle(Channels.recordingDock.getBounds, async (): Promise<RecordingDockBounds | null> =>
    getRecordingDockBounds()
  );

  ipcMain.handle(Channels.recordingDock.setBounds, async (_event, bounds: RecordingDockBounds): Promise<void> => {
    setRecordingDockBounds(bounds);
  });

  ipcMain.handle(Channels.recordingDock.sendAction, async (_event, action: RecordingDockAction): Promise<void> => {
    forwardRecordingDockAction(action);
  });

  ipcMain.handle(Channels.recordingDock.syncTimer, async (_event, sync: RecordingDockTimerSync): Promise<void> => {
    forwardRecordingDockTimerSync(sync);
  });

  ipcMain.handle(
    Channels.recordingDock.getTimerSync,
    async (): Promise<RecordingDockTimerSync | null> => getRecordingDockTimerSync()
  );

  ipcMain.handle(Channels.recordingDock.showMainWindow, async (): Promise<void> => {
    showMainWindowForDock();
  });

  ipcMain.handle(Channels.recordingDock.hideMainWindow, async (): Promise<void> => {
    hideMainWindowForDock();
  });

  ipcMain.handle(Channels.recordingDock.isMainWindowVisible, async (): Promise<boolean> => isMainWindowVisibleForDock());
}
