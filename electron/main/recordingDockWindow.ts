
import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { Channels } from "@shared/constants/channels";
import type {
  RecordingDockAction,
  RecordingDockBounds,
  RecordingDockConfig,
  RecordingDockOrientation,
  RecordingDockTimerSync,
} from "@shared/types/models";
import { getRecordingDockState, setRecordingDockState } from "./native/settingsStore";
import { registerAnnotationControlWindow, unregisterAnnotationControlWindow } from "./annotationWindow";

let win: BrowserWindow | null = null;
let mainWindowRef: BrowserWindow | null = null;

export function setMainWindowForRecordingDock(mainWin: BrowserWindow): void {
  mainWindowRef = mainWin;
  mainWin.on("show", () => broadcastMainWindowVisibility(true));
  mainWin.on("hide", () => broadcastMainWindowVisibility(false));
}

function broadcastMainWindowVisibility(visible: boolean): void {
  if (win && !win.isDestroyed()) win.webContents.send(Channels.recordingDock.mainWindowVisibilityChanged, visible);
}

function loadRoute(w: BrowserWindow, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    w.loadFile(path.join(__dirname, "../renderer/index.html"), { hash });
  }
}

const DEFAULT_CONFIG: RecordingDockConfig = { orientation: "horizontal" };

const persisted = getRecordingDockState();
let lastConfig: RecordingDockConfig = persisted.config ? { ...DEFAULT_CONFIG, ...persisted.config } : DEFAULT_CONFIG;
let lastBounds: RecordingDockBounds | null = persisted.bounds;

function persist(): void {
  setRecordingDockState(lastConfig, lastBounds);
}

function sizeFor(orientation: RecordingDockOrientation): { width: number; height: number } {
  return orientation === "horizontal" ? { width: 460, height: 64 } : { width: 64, height: 460 };
}

function displayForMainWindow(): Electron.Display {
  if (mainWindowRef && !mainWindowRef.isDestroyed() && !mainWindowRef.isMinimized()) {
    return screen.getDisplayMatching(mainWindowRef.getBounds());
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function isWithinDisplay(bounds: RecordingDockBounds, display: Electron.Display): boolean {
  const d = display.bounds;
  return bounds.x >= d.x && bounds.x < d.x + d.width && bounds.y >= d.y && bounds.y < d.y + d.height;
}

function ensureOnScreenBounds(bounds: RecordingDockBounds, orientation: RecordingDockOrientation): RecordingDockBounds {
  if (screen.getAllDisplays().some((d) => isWithinDisplay(bounds, d))) return bounds;
  console.error(`Recording dock: computed bounds ${JSON.stringify(bounds)} are off every display, re-deriving`);
  return defaultBoundsFor(orientation, screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
}

function defaultBoundsFor(orientation: RecordingDockOrientation, display: Electron.Display): RecordingDockBounds {
  const { width, height } = sizeFor(orientation);
  return {
    x: display.workArea.x + Math.round((display.workArea.width - width) / 2),
    y: display.workArea.y + display.workArea.height - height - 10,
    width,
    height,
  };
}

export function isRecordingDockOpen(): boolean {
  return !!win && !win.isDestroyed();
}

export function getRecordingDockConfig(): RecordingDockConfig {
  return lastConfig;
}

function resolveDockBounds(): RecordingDockBounds {
  const targetDisplay = displayForMainWindow();
  return ensureOnScreenBounds(
    lastBounds && isWithinDisplay(lastBounds, targetDisplay) ? lastBounds : defaultBoundsFor(lastConfig.orientation, targetDisplay),
    lastConfig.orientation
  );
}

export function getRecordingDockAnchorBounds(): RecordingDockBounds {
  if (win && !win.isDestroyed()) return win.getBounds();
  return resolveDockBounds();
}

export function openRecordingDockWindow(): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(Channels.recordingDock.configChanged, lastConfig);
    win.showInactive();
    win.setContentProtection(true);
    return;
  }

  const bounds = resolveDockBounds();
  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setBounds(bounds);
  loadRoute(win, "/recording-dock");

  const openedWin = win;
  let shown = false;
  const revealDock = (): void => {
    if (shown || openedWin.isDestroyed()) return;
    shown = true;
    clearTimeout(showFallbackTimer);
    openedWin.setBounds(bounds);
    openedWin.webContents.send(Channels.recordingDock.configChanged, lastConfig);
    openedWin.showInactive();
    openedWin.setContentProtection(true);
  };
  const showFallbackTimer = setTimeout(() => {
    if (shown || openedWin.isDestroyed()) return;
    console.error("Recording dock: ready-to-show didn't fire in time, forcing it visible");
    revealDock();
  }, 3000);
  openedWin.once("ready-to-show", revealDock);
  openedWin.webContents.once("did-fail-load", (_e, code, description) => {
    console.error(`Recording dock failed to load (${code}): ${description}`);
  });
  openedWin.on("closed", () => {
    clearTimeout(showFallbackTimer);
    if (win === openedWin) win = null;
    unregisterAnnotationControlWindow(openedWin);
  });
  openedWin.on("moved", () => {
    if (openedWin.isDestroyed()) return;
    lastBounds = openedWin.getBounds();
    persist();
  });
  registerAnnotationControlWindow(openedWin);
}

export function closeRecordingDockWindow(): void {
  if (win && !win.isDestroyed()) win.close();
  win = null;
  // Otherwise the next recording's dock could briefly pull this stale value (see
  // getRecordingDockTimerSync) before the fresh push for the new session arrives.
  lastTimerSync = null;
}

export function setRecordingDockOrientation(orientation: RecordingDockOrientation): void {
  lastConfig = { orientation };
  if (win && !win.isDestroyed()) {
    const current = win.getBounds();
    const { width, height } = sizeFor(orientation);
    const next: RecordingDockBounds = {
      x: Math.round(current.x + (current.width - width) / 2),
      y: Math.round(current.y + (current.height - height) / 2),
      width,
      height,
    };
    lastBounds = next;
    win.setBounds(next);
    win.webContents.send(Channels.recordingDock.configChanged, lastConfig);
  }
  persist();
}

export function getRecordingDockBounds(): RecordingDockBounds | null {
  if (win && !win.isDestroyed()) return win.getBounds();
  return lastBounds;
}

export function setRecordingDockBounds(bounds: RecordingDockBounds): void {
  lastBounds = bounds;
  persist();
  if (win && !win.isDestroyed()) win.setBounds(bounds);
}

export function forwardRecordingDockAction(action: RecordingDockAction): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w !== win) w.webContents.send(Channels.recordingDock.action, action);
  }
}

// Remembered so a dock window that opens *after* this fires (its BrowserWindow takes a
// moment to load, mount, and subscribe its onTimerSync listener — see openRecordingDockWindow)
// can pull the current state itself once ready, instead of only ever getting it pushed:
// a push sent before that listener is registered is simply dropped, no queueing, which
// was leaving the dock stuck showing 0:00 for however long recording ran before the next
// state-change (pause/resume) happened to push a fresh value.
let lastTimerSync: RecordingDockTimerSync | null = null;

export function forwardRecordingDockTimerSync(sync: RecordingDockTimerSync): void {
  lastTimerSync = sync;
  if (win && !win.isDestroyed()) win.webContents.send(Channels.recordingDock.timerSync, sync);
}

export function getRecordingDockTimerSync(): RecordingDockTimerSync | null {
  return lastTimerSync;
}

export function showMainWindowForDock(): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) mainWindowRef.show();
}

export function hideMainWindowForDock(): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) mainWindowRef.hide();
}

export function isMainWindowVisibleForDock(): boolean {
  return !!mainWindowRef && !mainWindowRef.isDestroyed() && mainWindowRef.isVisible();
}
