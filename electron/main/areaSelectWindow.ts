
import { BrowserWindow, screen, desktopCapturer, type Display } from "electron";
import path from "node:path";
import type { AreaRect } from "@shared/types/models";

const overlayWindows = new Map<number, BrowserWindow>();

let resultSent = false;

function loadRoute(win: BrowserWindow, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"), { hash });
  }
}

function broadcastToOtherWindows(channel: string, payload: unknown): void {
  const overlaySet = new Set<BrowserWindow>(overlayWindows.values());
  for (const win of BrowserWindow.getAllWindows()) {
    if (!overlaySet.has(win)) win.webContents.send(channel, payload);
  }
}

export function isAreaSelectOpen(): boolean {
  return overlayWindows.size > 0;
}

function createOverlayWindow(display: Display, targetId: string): BrowserWindow {
  const win = new BrowserWindow({
    ...display.bounds,
    transparent: true,
    backgroundColor: "#00000000",
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
  loadRoute(win, `/area-select?targetId=${encodeURIComponent(targetId)}`);

  win.once("ready-to-show", () => {
    win.setBounds(display.bounds);
    win.show();
  });
  win.on("closed", () => {
    if (overlayWindows.get(display.id) === win) overlayWindows.delete(display.id);
  });
  return win;
}

export async function openAreaSelectOverlay(): Promise<void> {
  if (overlayWindows.size > 0) return;
  resultSent = false;

  const displays = screen.getAllDisplays();
  const sources = await desktopCapturer.getSources({ types: ["screen"] });

  displays.forEach((display, i) => {
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[i];
    if (!source) return;
    overlayWindows.set(display.id, createOverlayWindow(display, source.id));
  });
}

function closeAllOverlayWindows(): void {
  for (const win of overlayWindows.values()) win.close();
  overlayWindows.clear();
}

export function activateAreaSelectWindow(win: BrowserWindow): void {
  for (const [id, w] of overlayWindows) {
    if (w === win) continue;
    w.close();
    overlayWindows.delete(id);
  }
}

export function completeAreaSelect(targetId: string, rect: AreaRect): void {
  if (overlayWindows.size === 0 || resultSent) return;
  resultSent = true;
  broadcastToOtherWindows("areaSelect:completed", { targetId, rect });
  closeAllOverlayWindows();
}

export function cancelAreaSelect(): void {
  if (overlayWindows.size === 0 || resultSent) return;
  resultSent = true;
  broadcastToOtherWindows("areaSelect:cancelled", undefined);
  closeAllOverlayWindows();
}

export function closeAreaSelectOverlay(): void {
  resultSent = true;
  closeAllOverlayWindows();
}
