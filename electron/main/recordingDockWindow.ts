
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

// The window is sized once, to fit the bar *plus* everything that can pop out of it, and
// never resized afterward. Resizing it to fit an opening popover is what caused the dock
// to visibly flicker: growing the window moves its top-left origin, and Windows presents
// the already-painted frame at that new origin for a frame or two before Chromium
// repaints, so the bar appeared to leap and settle back. Anything overflowing a window is
// hard-clipped rather than overhanging, so the room has to be reserved up front instead.
//
// The reserved area is empty and transparent; setRecordingDockInteractive keeps it
// click-through so it doesn't swallow clicks meant for whatever is behind the dock.
// Popovers open toward the same side tooltips do (up, for both orientations — see the
// popover/[data-tooltip] rules' `bottom: 100%`), except vertical, whose popovers open
// leftward (`right: 100%`); the bar is anchored flush to the opposite edge so all the
// slack lands on the side things actually open toward.
const POPOVER_RESERVE = 168;
const TOOLTIP_HEADROOM = 34;
const BAR_THICKNESS = 48;

function sizeFor(orientation: RecordingDockOrientation): { width: number; height: number } {
  // Vertical's bar width must fit the timer row (dot + "1:23:45" digits), which is wider
  // than the 30px button column — too narrow and the bar's flush-right-anchored left edge
  // (and its rounded corner) is clipped off rather than just leaving a gap.
  // 520 rather than the bar's ~490 measured content width: the timer is the one
  // variable-width part (it grows a whole field once a recording passes an hour), and
  // overflow here doesn't wrap or scroll, it clips the bar's rounded ends off against the
  // window edge — which is what used to make one end look square.
  return orientation === "horizontal"
    ? { width: 520, height: BAR_THICKNESS + POPOVER_RESERVE }
    : { width: 96 + POPOVER_RESERVE, height: 460 + TOOLTIP_HEADROOM };
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

// Bounds persisted by an older build (or a stale size from before a sizeFor tweak) can carry
// a width/height that no longer matches the current canonical size for this orientation — the
// bar is flush against one edge (bottom in horizontal, right in vertical; see the CSS's
// align-items/justify-content: flex-end), so a too-small size silently clips content off that
// edge instead of just leaving a gap. Re-apply the current size, anchored to the same flush
// edge, rather than trusting a persisted size verbatim.
function normalizeBoundsSize(bounds: RecordingDockBounds, orientation: RecordingDockOrientation): RecordingDockBounds {
  const { width, height } = sizeFor(orientation);
  if (bounds.width === width && bounds.height === height) return bounds;
  return {
    x: orientation === "vertical" ? bounds.x + bounds.width - width : bounds.x,
    y: orientation === "horizontal" ? bounds.y + bounds.height - height : bounds.y,
    width,
    height,
  };
}

// Most of the dock window is empty reserved space (see sizeFor). Without this it would
// still swallow every click landing in it, blocking a large always-on-top rectangle over
// whatever the user is recording. The renderer hit-tests the pointer against the bar and
// any open popover and reports the result here; `forward: true` is what keeps mouse moves
// flowing to the renderer even while the window is click-through, so it can tell when the
// pointer comes back over the bar and re-enable interaction.
let lastInteractive: boolean | null = null;

export function setRecordingDockInteractive(interactive: boolean): void {
  if (!win || win.isDestroyed()) return;
  if (lastInteractive === interactive) return;
  lastInteractive = interactive;
  win.setIgnoreMouseEvents(!interactive, { forward: true });
}

export function isRecordingDockOpen(): boolean {
  return !!win && !win.isDestroyed();
}

export function getRecordingDockConfig(): RecordingDockConfig {
  return lastConfig;
}

function resolveDockBounds(): RecordingDockBounds {
  const targetDisplay = displayForMainWindow();
  const candidate = lastBounds ? normalizeBoundsSize(lastBounds, lastConfig.orientation) : null;
  return ensureOnScreenBounds(
    candidate && isWithinDisplay(candidate, targetDisplay) ? candidate : defaultBoundsFor(lastConfig.orientation, targetDisplay),
    lastConfig.orientation
  );
}

/** Where the *visible bar* is on screen, which is only part of the dock window — the rest
 *  is the transparent reserve reasoned about in sizeFor. Callers positioning UI relative
 *  to the dock (the countdown bubble) want the bar, not the window, or they end up
 *  POPOVER_RESERVE px adrift of the thing they're supposed to sit next to. */
export function getRecordingDockAnchorBounds(): RecordingDockBounds {
  const b = win && !win.isDestroyed() ? win.getBounds() : resolveDockBounds();
  return lastConfig.orientation === "horizontal"
    ? { x: b.x, y: b.y + b.height - BAR_THICKNESS, width: b.width, height: BAR_THICKNESS }
    : { x: b.x + POPOVER_RESERVE, y: b.y + TOOLTIP_HEADROOM, width: b.width - POPOVER_RESERVE, height: b.height - TOOLTIP_HEADROOM };
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
  lastInteractive = null;
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

/** Bounds of the main window, only when it's actually on screen -- used to keep clicks on
 *  Doculigent's own UI out of the recorded click track (see cursorTrack.ts). */
export function getMainWindowBounds(): Electron.Rectangle | null {
  if (!mainWindowRef || mainWindowRef.isDestroyed() || !mainWindowRef.isVisible()) return null;
  return mainWindowRef.getBounds();
}
