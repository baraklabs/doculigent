
import { BrowserWindow, screen, type Display } from "electron";
import path from "node:path";
import type { AnnotationState, AnnotationTool } from "@shared/types/annotation";

const drawWindows = new Map<number, BrowserWindow>();
const controlWindows = new Set<BrowserWindow>();

export function setMainWindowForAnnotation(win: BrowserWindow): void {
  controlWindows.add(win);
  win.on("closed", () => controlWindows.delete(win));
}

export function registerAnnotationControlWindow(win: BrowserWindow): void {
  controlWindows.add(win);
  win.on("closed", () => controlWindows.delete(win));
}

export function unregisterAnnotationControlWindow(win: BrowserWindow): void {
  controlWindows.delete(win);
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
  win.setIgnoreMouseEvents(true, { forward: true });
  loadRoute(win, "/annotate/draw");
  win.once("ready-to-show", () => {
    win.setBounds(display.bounds);
    win.showInactive();
  });
  win.on("closed", () => {
    if (drawWindows.get(display.id) === win) drawWindows.delete(display.id);
  });
  return win;
}

function broadcastToOtherWindows(channel: string, payload: unknown): void {
  const overlayWindows = new Set<BrowserWindow>(drawWindows.values());
  for (const win of BrowserWindow.getAllWindows()) {
    if (!overlayWindows.has(win)) win.webContents.send(channel, payload);
  }
}

export function isAnnotationOverlayOpen(): boolean {
  return drawWindows.size > 0;
}

export function getDrawWindowIds(): number[] {
  return [...drawWindows.values()].map((win) => win.id);
}

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
  const cursor = screen.getCursorScreenPoint();
  let overControlWindow = false;
  for (const win of controlWindows) {
    if (win.isDestroyed() || !win.isVisible()) continue;
    const b = win.getBounds();
    if (cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height) {
      overControlWindow = true;
      break;
    }
  }
  applyClickThroughIfChanged(overControlWindow);
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

export function broadcastAnnotationState(state: AnnotationState): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("annotation:stateChanged", state);
}

export function sendAnnotationCommand(type: "undo" | "redo" | "clear"): void {
  for (const win of drawWindows.values()) win.webContents.send("annotation:command", type);
}

export function sendAnnotationHistoryState(canUndo: boolean, canRedo: boolean): void {
  broadcastToOtherWindows("annotation:historyStateChanged", { canUndo, canRedo });
}
