
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

/** Bounds of the camera bubble, only when it's actually visible on screen -- used to keep
 *  clicks on it out of the recorded click track (see cursorTrack.ts). Deliberately not
 *  getCameraBubbleBounds: that one falls back to lastBounds even while hidden (e.g. during
 *  the content-protection-unsafe window in RecordingService.start()), and a click landing
 *  in that same screen spot while the bubble is hidden is a real click on whatever's
 *  actually visible underneath, not on the bubble. */
export function getCameraBubbleBoundsIfVisible(): CameraBubbleBounds | null {
  if (!win || win.isDestroyed() || !win.isVisible()) return null;
  return win.getBounds();
}

export function getCameraBubbleConfig(): CameraBubbleConfig {
  return lastConfig;
}

export function setCameraBubbleContentProtected(protect: boolean): void {
  if (!win || win.isDestroyed()) return;
  win.setContentProtection(protect);
}

export function setCameraBubbleRecordingActive(active: boolean, contentProtected: boolean, keepVisible = false): void {
  if (!win || win.isDestroyed()) return;
  if (!active) {
    // Recording ended (of either mode) — always back to protected/hidden-from-capture by
    // default, undoing whatever setCameraBubbleContentProtected(false) a Quick recording
    // may have set at start.
    win.setContentProtection(true);
    if (!win.isVisible()) win.showInactive();
    win.webContents.send(Channels.cameraBubble.recordingActiveChanged, active, contentProtected);
    return;
  }
  // The camera is normally burned in from its own separately-recorded clip, never from
  // whatever this window happens to be showing — but the window itself stays visible on
  // screen throughout, so it must not be *in* the screen capture. `contentProtected` (see
  // native/screenCapture.ts's isCaptureContentProtected) tells us whether the active
  // backend can be trusted to exclude this window on its own: Windows' gdigrab native path
  // and macOS's ScreenCaptureKit path both proved reliable — Windows via
  // win.setContentProtection, macOS via ScreenCaptureKit automatically excluding
  // sharingType=.none windows (see ScreenCaptureKitRecorder.swift's header comment). When
  // it can't be trusted (Chromium's getDisplayMedia fallback on any platform, or macOS's
  // avfoundation fallback — confirmed unreliable: a live camera bubble ended up baked into
  // the supposedly camera-free screen.mp4 even with setContentProtection(true) set) this
  // hides the window outright instead: a hidden window can't appear in any capture no
  // matter how it's composited. The tradeoff there is the bubble can't be dragged *during*
  // such a recording — wherever it was positioned before hitting record is where it stays.
  //
  // `keepVisible` (Quick Recording) skips all of that — the caller has already called
  // setCameraBubbleContentProtected(false) and deliberately wants this window burned into
  // the capture directly, so it's never hidden regardless of backend trust.
  const shouldHide = !keepVisible && !contentProtected;
  console.log("[cameraBubbleWindow] setCameraBubbleRecordingActive", {
    active,
    contentProtected,
    keepVisible,
    shouldHide,
    wasVisible: win.isVisible(),
  });
  if (shouldHide) win.hide();
  win.webContents.send(Channels.cameraBubble.recordingActiveChanged, active, contentProtected);
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
