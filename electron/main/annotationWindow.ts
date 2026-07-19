/**
 * The "Draw on screen" annotation overlay — a single transparent, frameless window
 * (`drawWindow`) spanning the union of every display (the whole virtual desktop), which
 * toggles click-through via setIgnoreMouseEvents depending on the active tool —
 * "pointer" lets clicks fall through to whatever's underneath, any drawing tool captures
 * the whole screen's input until switched back.
 *
 * The color/tool/undo/redo/clear controls themselves live in the main app window (see
 * RecordPage's embedded toolbar), not a second floating window — this module just relays
 * their commands to drawWindow and relays its history state back, via the same "every
 * other window" broadcast pattern used for overlayOpenChanged.
 *
 * Uses `setAlwaysOnTop(true, 'screen-saver')`, the strongest level, so the overlay stays
 * visible even over another app's fullscreen window (e.g. a presentation).
 */
import { BrowserWindow, screen } from "electron";
import path from "node:path";

let drawWindow: BrowserWindow | null = null;

function loadRoute(win: BrowserWindow, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"), { hash });
  }
}

function virtualDesktopBounds(): { x: number; y: number; width: number; height: number } {
  const displays = screen.getAllDisplays();
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Sends to every window except the draw overlay itself — in practice just the main app
 *  window, but written generically rather than tracking a specific window reference. */
function broadcastToOtherWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win !== drawWindow) win.webContents.send(channel, payload);
  }
}

export function isAnnotationOverlayOpen(): boolean {
  return !!drawWindow;
}

/** Creates the overlay window if it doesn't exist yet, or just re-shows it if it does
 *  (idempotent — safe to call from a toggle button that doesn't track open state). */
export function openAnnotationOverlay(): void {
  if (drawWindow) {
    drawWindow.showInactive();
    broadcastToOtherWindows("annotation:overlayOpenChanged", true);
    return;
  }

  const bounds = virtualDesktopBounds();
  drawWindow = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  drawWindow.setAlwaysOnTop(true, "screen-saver");
  // Starts click-through (tool defaults to "pointer") so opening the overlay doesn't
  // immediately block interaction with whatever's on screen.
  drawWindow.setIgnoreMouseEvents(true, { forward: true });
  loadRoute(drawWindow, "/annotate/draw");
  // showInactive, not show — never steals OS focus from whatever the user's presenting.
  drawWindow.once("ready-to-show", () => drawWindow?.showInactive());
  drawWindow.on("closed", () => {
    drawWindow = null;
  });

  broadcastToOtherWindows("annotation:overlayOpenChanged", true);
}

/** Destroys the overlay window — any unsaved strokes are discarded (this is a live
 *  annotation tool, not a persisted-document editor). */
export function closeAnnotationOverlay(): void {
  const wasOpen = !!drawWindow;
  drawWindow?.close();
  drawWindow = null;
  if (wasOpen) broadcastToOtherWindows("annotation:overlayOpenChanged", false);
}

export function setAnnotationClickThrough(ignore: boolean): void {
  drawWindow?.setIgnoreMouseEvents(ignore, { forward: true });
}

/** Both the draw window (needs it to know how/what to draw) and the main window's
 *  embedded toolbar (needs it to reflect the current selection) get this. */
export function broadcastAnnotationState(tool: string, color: string): void {
  const payload = { tool, color };
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("annotation:stateChanged", payload);
}

export function sendAnnotationCommand(type: "undo" | "redo" | "clear"): void {
  drawWindow?.webContents.send("annotation:command", type);
}

/** Only the main window's embedded toolbar needs this, to enable/disable its undo/redo
 *  buttons — the draw window already knows its own history. */
export function sendAnnotationHistoryState(canUndo: boolean, canRedo: boolean): void {
  broadcastToOtherWindows("annotation:historyStateChanged", { canUndo, canRedo });
}
