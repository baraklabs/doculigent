import { BrowserWindow, ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import { ANNOTATION_COLORS, type AnnotationTool } from "@shared/types/annotation";
import {
  broadcastAnnotationState,
  closeAnnotationOverlay,
  getDrawWindowIds,
  isAnnotationOverlayOpen,
  openAnnotationOverlay,
  sendAnnotationCommand,
  sendAnnotationHistoryState,
  setAnnotationClickThrough,
} from "../annotationWindow";

// Main process is the source of truth for the *current* tool/color (cheap, small state)
// — strokes/history live in each draw window's own renderer, reported back only as a
// boolean pair for the toolbar's undo/redo buttons (see reportHistoryState below).
let currentTool: AnnotationTool = "pointer";
let currentColor: string = ANNOTATION_COLORS[0];

const historyByWindow = new Map<number, { canUndo: boolean; canRedo: boolean }>();

function reportAggregateHistory(): void {
  const liveIds = new Set(getDrawWindowIds());
  for (const id of historyByWindow.keys()) {
    if (!liveIds.has(id)) historyByWindow.delete(id);
  }
  const canUndo = [...historyByWindow.values()].some((v) => v.canUndo);
  const canRedo = [...historyByWindow.values()].some((v) => v.canRedo);
  sendAnnotationHistoryState(canUndo, canRedo);
}

export function registerAnnotationIpc(): void {
  ipcMain.handle(Channels.annotation.open, async (): Promise<void> => {
    currentTool = "pointer";
    openAnnotationOverlay();
    broadcastAnnotationState(currentTool, currentColor);
  });

  ipcMain.handle(Channels.annotation.close, async (): Promise<void> => {
    closeAnnotationOverlay();
    historyByWindow.clear();
    sendAnnotationHistoryState(false, false);
  });

  ipcMain.handle(Channels.annotation.isOpen, async (): Promise<boolean> => isAnnotationOverlayOpen());
  ipcMain.handle(
    Channels.annotation.getState,
    async (): Promise<{ tool: AnnotationTool; color: string }> => ({ tool: currentTool, color: currentColor })
  );

  ipcMain.handle(Channels.annotation.setTool, async (_event, tool: AnnotationTool): Promise<void> => {
    currentTool = tool;
    setAnnotationClickThrough(tool === "pointer");
    broadcastAnnotationState(currentTool, currentColor);
  });

  ipcMain.handle(Channels.annotation.setColor, async (_event, color: string): Promise<void> => {
    currentColor = color;
    broadcastAnnotationState(currentTool, currentColor);
  });

  ipcMain.handle(Channels.annotation.undo, async (): Promise<void> => {
    sendAnnotationCommand("undo");
  });

  ipcMain.handle(Channels.annotation.redo, async (): Promise<void> => {
    sendAnnotationCommand("redo");
  });

  ipcMain.handle(Channels.annotation.clear, async (): Promise<void> => {
    sendAnnotationCommand("clear");
  });

  ipcMain.handle(
    Channels.annotation.reportHistoryState,
    async (event, canUndo: boolean, canRedo: boolean): Promise<void> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) historyByWindow.set(win.id, { canUndo, canRedo });
      reportAggregateHistory();
    }
  );
}
