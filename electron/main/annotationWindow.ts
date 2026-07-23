
import { BrowserWindow, screen, type Display } from "electron";
import path from "node:path";
import type { AnnotationTool } from "@shared/types/annotation";

const drawWindows = new Map<number, BrowserWindow>();

let mainWindowRef: BrowserWindow | null = null;

export function setMainWindowForAnnotation(win: BrowserWindow): void {
  mainWindowRef = win;
}

function loadRoute(win: BrowserWindow, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"), { hash });
  }
}

function createDrawWindow(display: Display): BrowserWindow {
  const win = new BrowserWindow({
    ...display.bounds,
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
  
  win.setBounds(display.bounds);
  win.setAlwaysOnTop(true, "screen-saver");
  // Starts click-through (tool defaults to "pointer") so opening the overlay doesn't
  // immediately block interaction with whatever's on screen.
  win.setIgnoreMouseEvents(true, { forward: true });
  loadRoute(win, "/annotate/draw");
  // showInactive, not show — never steals OS focus from whatever the user's presenting.
  win.once("ready-to-show", () => {
    win.setBounds(display.bounds);
    win.showInactive();
  });
  win.on("closed", () => {
    if (drawWindows.get(display.id) === win) drawWindows.delete(display.id);
  });
  return win;
}

/** Sends to every window except the draw overlay windows — in practice just the main app
 *  window, but written generically rather than tracking a specific window reference. */
function broadcastToOtherWindows(channel: string, payload: unknown): void {
  const overlayWindows = new Set<BrowserWindow>(drawWindows.values());
  for (const win of BrowserWindow.getAllWindows()) {
    if (!overlayWindows.has(win)) win.webContents.send(channel, payload);
  }
}

export function isAnnotationOverlayOpen(): boolean {
  return drawWindows.size > 0;
}

/** BrowserWindow ids of the currently open draw windows — used by ipc/annotation.ts to
 *  prune per-window undo/redo state for windows that have since closed. */
export function getDrawWindowIds(): number[] {
  return [...drawWindows.values()].map((win) => win.id);
}

/** Creates one overlay window per currently connected display if none exist yet, or just
 *  re-shows them if they do (idempotent — safe to call from a toggle button that doesn't
 *  track open state). */
export function openAnnotationOverlay(): void {
  if (drawWindows.size > 0) {
    for (const win of drawWindows.values()) win.showInactive();
    broadcastToOtherWindows("annotation:overlayOpenChanged", true);
    return;
  }

  for (const display of screen.getAllDisplays()) {
    drawWindows.set(display.id, createDrawWindow(display));
  }

  broadcastToOtherWindows("annotation:overlayOpenChanged", true);
}

/** Destroys every overlay window — any unsaved strokes are discarded (this is a live
 *  annotation tool, not a persisted-document editor). */
export function closeAnnotationOverlay(): void {
  const wasOpen = drawWindows.size > 0;
  for (const win of drawWindows.values()) win.close();
  drawWindows.clear();
  stopCursorPoll();
  lastAppliedClickThrough = null;
  strokeActive = false;
  if (wasOpen) broadcastToOtherWindows("annotation:overlayOpenChanged", false);
}

let lastAppliedClickThrough: boolean | null = null;

function applyClickThroughIfChanged(ignore: boolean): void {
  if (lastAppliedClickThrough === ignore) return;
  lastAppliedClickThrough = ignore;
  for (const win of drawWindows.values()) win.setIgnoreMouseEvents(ignore, { forward: true });
}

let cursorPollTimer: ReturnType<typeof setInterval> | null = null;

function stopCursorPoll(): void {
  if (cursorPollTimer) {
    clearInterval(cursorPollTimer);
    cursorPollTimer = null;
  }
}

let strokeActive = false;

export function setStrokeActive(active: boolean): void {
  strokeActive = active;
}


function pollCursorAgainstMainWindow(): void {
  if (strokeActive) return;
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    applyClickThroughIfChanged(false);
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const b = mainWindowRef.getBounds();
  const overMainWindow = cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
  applyClickThroughIfChanged(overMainWindow);
}


export function updateClickThroughForTool(tool: AnnotationTool): void {
  if (tool === "pointer") {
    stopCursorPoll();
    applyClickThroughIfChanged(true);
    return;
  }
  if (!cursorPollTimer) {
    pollCursorAgainstMainWindow();
    cursorPollTimer = setInterval(pollCursorAgainstMainWindow, 33);
  }
}

/** Every draw window (needs it to know how/what to draw) and the main window's embedded
 *  toolbar (needs it to reflect the current selection) get this. */
export function broadcastAnnotationState(tool: string, color: string): void {
  const payload = { tool, color };
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("annotation:stateChanged", payload);
}

export function sendAnnotationCommand(type: "undo" | "redo" | "clear"): void {
  for (const win of drawWindows.values()) win.webContents.send("annotation:command", type);
}

/** Only the main window's embedded toolbar needs this, to enable/disable its undo/redo
 *  buttons — each draw window already knows its own history. */
export function sendAnnotationHistoryState(canUndo: boolean, canRedo: boolean): void {
  broadcastToOtherWindows("annotation:historyStateChanged", { canUndo, canRedo });
}
