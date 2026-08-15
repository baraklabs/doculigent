
import { BrowserWindow } from "electron";
import path from "node:path";
import { Channels } from "@shared/constants/channels";
import { getRecordingDockAnchorBounds } from "./recordingDockWindow";

let win: BrowserWindow | null = null;

const WIDTH = 110;
const HEIGHT = 84;
const GAP = 14;

function loadRoute(w: BrowserWindow, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    w.loadFile(path.join(__dirname, "../renderer/index.html"), { hash });
  }
}

function boundsAboveDock(): { x: number; y: number; width: number; height: number } {
  const dock = getRecordingDockAnchorBounds();
  return {
    x: Math.round(dock.x + (dock.width - WIDTH) / 2),
    y: Math.round(dock.y - HEIGHT - GAP),
    width: WIDTH,
    height: HEIGHT,
  };
}

export function isCountdownWindowOpen(): boolean {
  return !!win && !win.isDestroyed();
}

export function openCountdownWindow(secondsRemaining: number): void {
  const bounds = boundsAboveDock();
  if (win && !win.isDestroyed()) {
    win.setBounds(bounds);
    win.webContents.send(Channels.countdown.tick, secondsRemaining);
    win.showInactive();
    win.setAlwaysOnTop(true, "screen-saver");
    win.moveTop();
    win.setContentProtection(true);
    return;
  }

  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
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
  loadRoute(win, "/countdown");

  const openedWin = win;
  let shown = false;
  const reveal = (): void => {
    if (shown || openedWin.isDestroyed()) return;
    shown = true;
    clearTimeout(showFallbackTimer);
    openedWin.setBounds(boundsAboveDock());
    openedWin.webContents.send(Channels.countdown.tick, secondsRemaining);
    openedWin.showInactive();
    openedWin.setAlwaysOnTop(true, "screen-saver");
    openedWin.moveTop();
    openedWin.setContentProtection(true);
  };
  const showFallbackTimer = setTimeout(() => {
    if (shown || openedWin.isDestroyed()) return;
    console.error("Countdown window: ready-to-show didn't fire in time, forcing it visible");
    reveal();
  }, 1500);
  openedWin.once("ready-to-show", reveal);
  openedWin.webContents.once("did-fail-load", (_e, code, description) => {
    console.error(`Countdown window failed to load (${code}): ${description}`);
  });
  openedWin.on("closed", () => {
    clearTimeout(showFallbackTimer);
    if (win === openedWin) win = null;
  });
}

export function closeCountdownWindow(): void {
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

export function forwardCountdownCancel(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w !== win) w.webContents.send(Channels.countdown.cancelled);
  }
}
