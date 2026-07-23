import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import { ANNOTATION_COLORS, type AnnotationTool } from "@shared/types/annotation";
import {
  broadcastAnnotationState,
  closeAnnotationOverlay,
  isAnnotationOverlayOpen,
  openAnnotationOverlay,
  sendAnnotationCommand,
  sendAnnotationHistoryState,
  setAnnotationClickThrough,
} from "../annotationWindow";

// Main process is the source of truth for the *current* tool/color (cheap, small state)
// — strokes/history live in the draw window's own renderer, reported back only as a
// boolean pair for the toolbar's undo/redo buttons (see reportHistoryState below).
let currentTool: AnnotationTool = "pointer";
let currentColor: string = ANNOTATION_COLORS[0];

export function registerAnnotationIpc(): void {
  ipcMain.handle(Channels.annotation.open, async (): Promise<void> => {
    currentTool = "pointer";
    openAnnotationOverlay();
    broadcastAnnotationState(currentTool, currentColor);
  });

  ipcMain.handle(Channels.annotation.close, async (): Promise<void> => {
    closeAnnotationOverlay();
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
    async (_event, canUndo: boolean, canRedo: boolean): Promise<void> => {
      sendAnnotationHistoryState(canUndo, canRedo);
    }
  );
}
