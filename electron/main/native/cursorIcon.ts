import { spawn } from "node:child_process";
import ffmpegStaticPath from "ffmpeg-static";
import type { LibraryHandle } from "koffi";

const ffmpegPath = (ffmpegStaticPath ?? "ffmpeg").replace("app.asar", "app.asar.unpacked");

type Fn = (...args: unknown[]) => unknown;
type KoffiModule = typeof import("koffi");

let bindAttempted = false;
let user32: LibraryHandle | null = null;
let gdi32: LibraryHandle | null = null;
let getCursorInfoFn: Fn | null = null;
let getAsyncKeyStateFn: Fn | null = null;
let getIconInfoFn: Fn | null = null;
let getObjectWFn: Fn | null = null;
let getDIBitsFn: Fn | null = null;
let getDCFn: Fn | null = null;
let releaseDCFn: Fn | null = null;
let deleteObjectFn: Fn | null = null;
let bitmapInfoHeaderSize = 0;
let bitmapStructSize = 0;

// macOS left-button polling — separate from `bind()` above (Windows-only, user32/gdi32)
// since this needs a different library, symbol, and calling convention. Requires the
// "Input Monitoring" permission (System Settings > Privacy & Security > Input Monitoring);
// Electron has no API to check or prompt for that one specifically (unlike Screen
// Recording), so this just silently reports no clicks until the user grants it manually —
// same degrade-quietly behavior as everything else in this file when its OS API isn't
// available.
let macBindAttempted = false;
let macCoreGraphics: LibraryHandle | null = null;
let macButtonStateFn: Fn | null = null;
let macLeftButtonWasDown = false;

const CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE = 1;
const CG_MOUSE_BUTTON_LEFT = 0;

function bindMac(): boolean {
  if (macBindAttempted) return !!macButtonStateFn;
  macBindAttempted = true;
  if (process.platform !== "darwin") return false;
  try {
    const koffi = require("koffi") as KoffiModule;
    macCoreGraphics = koffi.load("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices");
    macButtonStateFn = macCoreGraphics.func("CGEventSourceButtonState", "bool", ["int32", "int32"]) as Fn;
    console.log("[cursorIcon] mac CGEventSourceButtonState bound successfully");
    return true;
  } catch (e) {
    console.error("[cursorIcon] failed to bind CGEventSourceButtonState — clicks won't be detected", e);
    macCoreGraphics = null;
    macButtonStateFn = null;
    return false;
  }
}

let macPollLogged = false;

function pollLeftButtonMac(): LeftButtonState {
  if (!bindMac() || !macButtonStateFn) return { isDown: false, wasPressed: false };
  try {
    const isDown = macButtonStateFn(CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE, CG_MOUSE_BUTTON_LEFT) as boolean;
    // CGEventSourceButtonState is a plain state query, not an edge-triggered "since last
    // call" flag like GetAsyncKeyState's low bit — approximate one from the down/up
    // transition between polls instead. A click briefer than one poll interval could in
    // theory land fully between two samples and be missed, same caveat GetAsyncKeyState's
    // own bit has at high enough click rates.
    const wasPressed = isDown && !macLeftButtonWasDown;
    macLeftButtonWasDown = isDown;
    if (!macPollLogged) {
      // Only once per process, not per poll (this runs at 60Hz) — just confirms the call
      // itself doesn't throw and returns a real value (permission-denied still returns
      // `false` silently rather than erroring, so this can't distinguish "no permission"
      // from "button really isn't down right now").
      macPollLogged = true;
      console.log("[cursorIcon] first mac button-state poll succeeded", { isDown });
    }
    return { isDown, wasPressed };
  } catch (e) {
    console.error("[cursorIcon] CGEventSourceButtonState call threw", e);
    return { isDown: false, wasPressed: false };
  }
}

function bind(): boolean {
  if (bindAttempted) return !!user32;
  bindAttempted = true;
  if (process.platform !== "win32") return false;
  try {
    const koffi = require("koffi") as KoffiModule;
    user32 = koffi.load("user32.dll");
    gdi32 = koffi.load("gdi32.dll");

    const POINT = koffi.struct("DlPoint", { x: "int32", y: "int32" });
    const CURSORINFO = koffi.struct("DlCursorInfo", {
      cbSize: "uint32",
      flags: "uint32",
      hCursor: "void *",
      ptScreenPos: POINT,
    });
    const ICONINFO = koffi.struct("DlIconInfo", {
      fIcon: "int32",
      xHotspot: "uint32",
      yHotspot: "uint32",
      hbmMask: "void *",
      hbmColor: "void *",
    });
    const BITMAP = koffi.struct("DlBitmap", {
      bmType: "int32",
      bmWidth: "int32",
      bmHeight: "int32",
      bmWidthBytes: "int32",
      bmPlanes: "uint16",
      bmBitsPixel: "uint16",
      bmBits: "void *",
    });
    const BITMAPINFOHEADER = koffi.struct("DlBitmapInfoHeader", {
      biSize: "uint32",
      biWidth: "int32",
      biHeight: "int32",
      biPlanes: "uint16",
      biBitCount: "uint16",
      biCompression: "uint32",
      biSizeImage: "uint32",
      biXPelsPerMeter: "int32",
      biYPelsPerMeter: "int32",
      biClrUsed: "uint32",
      biClrImportant: "uint32",
    });
    bitmapInfoHeaderSize = koffi.sizeof(BITMAPINFOHEADER);
    bitmapStructSize = koffi.sizeof(BITMAP);

    getCursorInfoFn = user32.func("__stdcall", "GetCursorInfo", "bool", [
      koffi.out(koffi.pointer(CURSORINFO)),
    ]) as Fn;
    getAsyncKeyStateFn = user32.func("__stdcall", "GetAsyncKeyState", "int16", ["int32"]) as Fn;
    getIconInfoFn = user32.func("__stdcall", "GetIconInfo", "bool", [
      "void *",
      koffi.out(koffi.pointer(ICONINFO)),
    ]) as Fn;
    getObjectWFn = gdi32.func("__stdcall", "GetObjectW", "int32", [
      "void *",
      "int32",
      koffi.out(koffi.pointer(BITMAP)),
    ]) as Fn;
    getDIBitsFn = gdi32.func("__stdcall", "GetDIBits", "int32", [
      "void *",
      "void *",
      "uint32",
      "uint32",
      koffi.out("void *"),
      koffi.inout(koffi.pointer(BITMAPINFOHEADER)),
      "uint32",
    ]) as Fn;
    getDCFn = user32.func("__stdcall", "GetDC", "void *", ["void *"]) as Fn;
    releaseDCFn = user32.func("__stdcall", "ReleaseDC", "int32", ["void *", "void *"]) as Fn;
    deleteObjectFn = gdi32.func("__stdcall", "DeleteObject", "bool", ["void *"]) as Fn;
    return true;
  } catch {
    user32 = null;
    return false;
  }
}

export interface CursorShape {
  key: string;
  hCursor: unknown;
}

export function sampleCursorShape(): CursorShape | null {
  if (!bind() || !getCursorInfoFn) return null;
  try {
    const ci: { hCursor?: unknown } = {};
    const ok = getCursorInfoFn(ci) as boolean;
    if (!ok || !ci.hCursor) return null;
    return { key: String(ci.hCursor), hCursor: ci.hCursor };
  } catch {
    return null;
  }
}

const VK_LBUTTON = 0x01;

export interface LeftButtonState {
  /** Physically held down right now. */
  isDown: boolean;
  /** Pressed at some point since the previous call — catches clicks that fully
   *  press-and-release between two polls, which a currently-down check alone would miss
   *  at typical sampling rates. On Windows this is GetAsyncKeyState's own "since last
   *  call" bit; on macOS (no such bit available) it's approximated from the down/up
   *  transition across polls instead — see pollLeftButtonMac above. */
  wasPressed: boolean;
}

/** System-wide left mouse button state (not just within the app). On Windows, each call
 *  consumes GetAsyncKeyState's "since last call" bit, so this must be the only poller of
 *  VK_LBUTTON; macOS has no such shared, consumable bit to worry about. */
export function pollLeftButton(): LeftButtonState {
  if (process.platform === "darwin") return pollLeftButtonMac();
  if (!bind() || !getAsyncKeyStateFn) return { isDown: false, wasPressed: false };
  try {
    const state = getAsyncKeyStateFn(VK_LBUTTON) as number;
    return { isDown: (state & 0x8000) !== 0, wasPressed: (state & 0x0001) !== 0 };
  } catch {
    return { isDown: false, wasPressed: false };
  }
}

export interface CapturedCursorBitmap {
  hotspotX: number;
  hotspotY: number;
  width: number;
  height: number;
  rgba: Buffer;
}

const MAX_ICON_DIMENSION = 256;

export function captureCursorBitmap(hCursor: unknown): CapturedCursorBitmap | null {
  if (!bind() || !getIconInfoFn || !getObjectWFn || !getDIBitsFn || !getDCFn) return null;

  let hbmMask: unknown = null;
  let hbmColor: unknown = null;
  let hdc: unknown = null;
  try {
    const ii: { xHotspot?: number; yHotspot?: number; hbmMask?: unknown; hbmColor?: unknown } = {};
    if (!(getIconInfoFn(hCursor, ii) as boolean)) return null;
    hbmMask = ii.hbmMask ?? null;
    hbmColor = ii.hbmColor ?? null;
    if (!hbmColor) return null;

    const bmp: { bmWidth?: number; bmHeight?: number; bmBitsPixel?: number } = {};
    const objSize = getObjectWFn(hbmColor, bitmapStructSize, bmp) as number;
    if (!objSize) return null;
    const width = bmp.bmWidth ?? 0;
    const height = bmp.bmHeight ?? 0;
    if (width <= 0 || height <= 0 || width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION) return null;
    if (bmp.bmBitsPixel !== 32) return null;

    hdc = getDCFn(null);
    if (!hdc) return null;

    const bih = {
      biSize: bitmapInfoHeaderSize,
      biWidth: width,
      biHeight: -height,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0,
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    };
    const bgra = Buffer.alloc(width * height * 4);
    const lines = getDIBitsFn(hdc, hbmColor, 0, height, bgra, bih, 0) as number;
    if (lines !== height) return null;

    for (let i = 0; i < bgra.length; i += 4) {
      const b = bgra[i];
      bgra[i] = bgra[i + 2];
      bgra[i + 2] = b;
    }

    return {
      hotspotX: ii.xHotspot ?? Math.round(width / 2),
      hotspotY: ii.yHotspot ?? Math.round(height / 2),
      width,
      height,
      rgba: bgra,
    };
  } catch {
    return null;
  } finally {
    if (hdc) releaseDCFn?.(null, hdc);
    if (hbmMask) deleteObjectFn?.(hbmMask);
    if (hbmColor) deleteObjectFn?.(hbmColor);
  }
}

export function rgbaToPng(rgba: Buffer, width: number, height: number, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      ["-y", "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${width}x${height}`, "-i", "pipe:0", outPath],
      { stdio: ["pipe", "ignore", "pipe"] }
    );
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d;
    });
    proc.once("error", reject);
    proc.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cursor icon PNG encode failed: ${stderr.slice(-500)}`));
    });
    proc.stdin.end(rgba);
  });
}

const FALLBACK_SIZE = 32;
const ARROW_POLY: [number, number][] = [
  [2, 2],
  [2, 24],
  [8, 19],
  [12, 27],
  [15, 25],
  [11, 17],
  [18, 17],
];

function pointInPolygon(px: number, py: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const crosses = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToPolygon(px: number, py: number, poly: [number, number][]): number {
  let min = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[j];
    const [x2, y2] = poly[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2));
    min = Math.min(min, Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)));
  }
  return min;
}

export async function renderFallbackArrowPng(outPath: string): Promise<void> {
  const size = FALLBACK_SIZE;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = pointInPolygon(x + 0.5, y + 0.5, ARROW_POLY);
      const onEdge = distanceToPolygon(x + 0.5, y + 0.5, ARROW_POLY) < 1.1;
      if (!inside && !onEdge) continue;
      const idx = (y * size + x) * 4;
      const outline = onEdge && !inside;
      rgba[idx] = outline ? 20 : 255;
      rgba[idx + 1] = outline ? 20 : 255;
      rgba[idx + 2] = outline ? 30 : 255;
      rgba[idx + 3] = 255;
    }
  }
  await rgbaToPng(rgba, size, size, outPath);
}

export const FALLBACK_ICON = { width: FALLBACK_SIZE, height: FALLBACK_SIZE, hotspotX: 2, hotspotY: 2 };
