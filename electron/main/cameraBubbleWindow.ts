
import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { Channels } from "@shared/constants/channels";
import type { CameraBubbleBounds, CameraBubbleConfig, CameraBubbleShape } from "@shared/types/models";
import { getCameraBubbleState, setCameraBubbleState } from "./native/settingsStore";

let win: BrowserWindow | null = null;

function loadRoute(w: BrowserWindow, hash: string): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  } else {
    w.loadFile(path.join(__dirname, "../renderer/index.html"), { hash });
  }
}

const EDGE_MARGIN = 40;
const DEFAULT_CONFIG: CameraBubbleConfig = {
  shape: "round",
  roundedCorners: true,
  freeformResize: false,
  mirror: true,
  cameraDeviceId: null,
  blur: "none",
};

const persisted = getCameraBubbleState();
let lastConfig: CameraBubbleConfig = persisted.config ? { ...DEFAULT_CONFIG, ...persisted.config } : DEFAULT_CONFIG;
let lastBounds: CameraBubbleBounds | null = persisted.bounds;

function persist(): void {
  setCameraBubbleState(lastConfig, lastBounds);
}

function defaultSizeFor(shape: CameraBubbleShape): { width: number; height: number } {
  switch (shape) {
    case "rectangle":
      return { width: 260, height: 160 };
    case "rectangle-vertical":
      return { width: 160, height: 260 };
    default:
      return { width: 220, height: 220 };
  }
}

function resolveBounds(shape: CameraBubbleShape): CameraBubbleBounds {
  if (lastBounds) return lastBounds;
  const display = screen.getPrimaryDisplay();
  const { width, height } = defaultSizeFor(shape);
  return {
    x: display.workArea.x + display.workArea.width - width - EDGE_MARGIN,
    y: display.workArea.y + display.workArea.height - height - EDGE_MARGIN,
    width,
    height,
  };
}

let hoverPollTimer: ReturnType<typeof setInterval> | null = null;
let isHovering = false;

function startHoverPoll(): void {
  if (hoverPollTimer) return;
  hoverPollTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const inside = cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
    if (inside === isHovering) return;
    isHovering = inside;
    win.webContents.send("cameraBubble:hoverChanged", isHovering);
  }, 50);
}

function stopHoverPoll(): void {
  if (hoverPollTimer) {
    clearInterval(hoverPollTimer);
    hoverPollTimer = null;
  }
  isHovering = false;
}

export function isCameraBubbleWindowOpen(): boolean {
  return !!win && !win.isDestroyed();
}

export function getCameraBubbleBounds(): CameraBubbleBounds | null {
  if (win && !win.isDestroyed()) return win.getBounds();
  return lastBounds;
}

export function getCameraBubbleConfig(): CameraBubbleConfig {
  return lastConfig;
}

export function setCameraBubbleRecordingActive(active: boolean, native: boolean): void {
  if (!win || win.isDestroyed()) return;
  // The camera is always burned in from its own separately-recorded clip, never from
  // whatever this window happens to be showing — but the window itself stays visible on
  // screen throughout, so it must not be *in* the screen capture. On Windows' native
  // (gdigrab) path that's win.setContentProtection's job — proven reliable there. On the
  // Chromium fallback path (getDisplayMedia, same-process) content protection is NOT
  // reliably honored on Windows (confirmed — without hiding, the window's own content was
  // showing up baked directly into the recorded screen). Actually hiding the window, rather
  // than just swapping out what it renders, works regardless of that: a hidden window can't
  // appear in any capture no matter how it's composited. The tradeoff is that the bubble
  // can't be dragged *during* a fallback recording on Windows — wherever it was positioned
  // before hitting record is where it stays for that recording.
  //
  // macOS was assumed to be like Windows' native case (trust setContentProtection, never
  // hide) once native/screenCapture.ts grew an avfoundation-based native path — but that
  // assumption was wrong: confirmed by testing that setContentProtection's
  // NSWindowSharingType does NOT reliably exclude the window from ffmpeg's avfoundation
  // capture (a live camera bubble ended up baked into the supposedly camera-free
  // screen.mp4 even with native:true). So macOS always hides during recording regardless
  // of native, same as the Windows fallback case — the live on-screen preview disappearing
  // for the recording's duration is the accepted cost since content protection can't be
  // trusted there; the actually-recorded camera.webm comes from the independent
  // getUserMedia stream (RecordingService's sideClip), not from this window, so hiding it
  // doesn't affect what gets recorded.
  const shouldHide = active && (process.platform === "darwin" || !native);
  console.log("[cameraBubbleWindow] setCameraBubbleRecordingActive", { active, native, shouldHide, wasVisible: win.isVisible() });
  if (shouldHide) win.hide();
  else if (!active && !win.isVisible()) win.showInactive();
  win.webContents.send(Channels.cameraBubble.recordingActiveChanged, active, native);
}

export function openCameraBubbleWindow(partial: Pick<CameraBubbleConfig, "mirror" | "cameraDeviceId" | "blur">): void {
  lastConfig = { ...lastConfig, ...partial };
  persist();

  if (win && !win.isDestroyed()) {
    win.webContents.send("cameraBubble:configChanged", lastConfig);
    win.showInactive();
    win.setContentProtection(true);
    startHoverPoll();
    return;
  }

  const bounds = resolveBounds(lastConfig.shape);
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
  loadRoute(win, "/camera-bubble");

  const openedWin = win;
  openedWin.once("ready-to-show", () => {
    if (openedWin.isDestroyed()) return;
    openedWin.setBounds(bounds);
    openedWin.webContents.send("cameraBubble:configChanged", lastConfig);
    openedWin.showInactive();
    openedWin.setContentProtection(true);
    startHoverPoll();
  });
  
  openedWin.on("closed", () => {
    if (win === openedWin) win = null;
    stopHoverPoll();
    for (const other of BrowserWindow.getAllWindows()) other.webContents.send("cameraBubble:closedByUser");
  });
}

export function closeCameraBubbleWindow(): void {
  stopHoverPoll();
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

export function updateCameraBubbleConfig(partial: Pick<CameraBubbleConfig, "mirror" | "cameraDeviceId" | "blur">): void {
  lastConfig = { ...lastConfig, ...partial };
  persist();
  if (!win || win.isDestroyed()) return;
  win.webContents.send("cameraBubble:configChanged", lastConfig);
}

export function setCameraBubbleShape(
  partial: Pick<CameraBubbleConfig, "shape" | "roundedCorners" | "freeformResize">
): void {
  lastConfig = { ...lastConfig, ...partial };
  persist();
  if (!win || win.isDestroyed()) return;
  win.webContents.send("cameraBubble:configChanged", lastConfig);
}

export function setCameraBubbleBounds(bounds: CameraBubbleBounds): void {
  lastBounds = bounds;
  persist();
  if (!win || win.isDestroyed()) return;
  win.setBounds(bounds);
}

export function setCameraBubbleShapeRegion(rects: { x: number; y: number; width: number; height: number }[]): void {
  if (process.platform === "darwin") return;
  if (!win || win.isDestroyed()) return;
  win.setShape(rects);
}
