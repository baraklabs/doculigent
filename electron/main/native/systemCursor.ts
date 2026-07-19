/**
 * Real OS-level mouse cursor swap for the Record page's cursor-highlight feature.
 * Electron's screen capture always bakes the real Windows cursor into the captured
 * frames, so the only way to change what shows up in a recording is to change the
 * actual system cursor while recording, not draw an overlay on top of it.
 *
 * Windows-only (guarded by `process.platform`) — everything here no-ops elsewhere.
 *
 * Every style here ends in SetSystemCursor swapping the main pointer for one of:
 *  - a stock Win32 cursor (hand/crosshair)
 *  - one of the larger arrow cursor files Windows itself ships alongside the normal one
 *    (bigger/huge), loaded via LoadCursorFromFileW. The "CursorBaseSize" continuous-scale
 *    registry value (what the Settings > Ease of Access pointer-size slider writes) was
 *    tried first, but it only takes visible effect on the newer vector-based cursor
 *    schemes — not the classic "Windows Aero" bitmap scheme many systems still use — so
 *    it silently did nothing. Loading a genuinely different, larger bitmap file
 *    sidesteps that.
 *  - a custom-drawn colored cursor (colorArrow/colorHand), built at runtime via GDI+
 *    (gdiplus.dll) since Windows doesn't ship any pre-colored cursor files to just load.
 *
 * All styles are undone the same way: restoreCursor() reloads the user's real scheme
 * from the registry (SPI_SETCURSORS) — the standard way other apps undo SetSystemCursor.
 * No per-style undo state is needed since none of this touches the registry itself.
 */
import koffi from "koffi";
import type { CursorHighlightStyle } from "@shared/types/models";
import { clearCursorOverride, getCursorOverride, setCursorOverride } from "./settingsStore";

// IDC_* (LoadCursor resource ids) and OCR_* (SetSystemCursor system-cursor ids) share the
// same numeric values for the cursors used here — a holdover from 16-bit Windows.
const IDC_HAND = 32649;
const IDC_CROSS = 32515;
const OCR_NORMAL = 32512;

const SPI_SETCURSORS = 0x0057;
const SPIF_SENDCHANGE = 0x02;

// Real bitmap files Windows ships alongside the normal arrow cursor, at larger fixed
// sizes — see the file-level comment above for why this beats CursorBaseSize scaling.
const CURSORS_DIR = String.raw`${process.env.SystemRoot ?? "C:\Windows"}\Cursors`;
const BIG_ARROW_FILE = String.raw`${CURSORS_DIR}\aero_arrow_l.cur`;
const HUGE_ARROW_FILE = String.raw`${CURSORS_DIR}\aero_arrow_xl.cur`;

// Custom cursor colors (packed 0xAARRGGBB), chosen for tutorial/recording visibility —
// a vivid orange arrow and the app's own accent purple for the hand/dot style, so the
// two read as distinctly different "color and style" options, not just resizes.
const COLOR_ARROW_ARGB = 0xffff7a00;
const COLOR_HAND_ARGB = 0xff6d5efc;
const OUTLINE_ARGB = 0xff1c1e2a;

type Fn = (...args: unknown[]) => unknown;

let user32: ReturnType<typeof koffi.load> | null = null;
let loadCursorW: Fn | null = null;
let loadCursorFromFileW: Fn | null = null;
let copyIcon: Fn | null = null;
let setSystemCursor: Fn | null = null;
let systemParametersInfoW: Fn | null = null;

function bind(): boolean {
  if (process.platform !== "win32") return false;
  if (user32) return true;
  try {
    user32 = koffi.load("user32.dll");
    loadCursorW = user32.func("__stdcall", "LoadCursorW", "void *", ["void *", "uintptr_t"]) as Fn;
    loadCursorFromFileW = user32.func("__stdcall", "LoadCursorFromFileW", "void *", ["str16"]) as Fn;
    copyIcon = user32.func("__stdcall", "CopyIcon", "void *", ["void *"]) as Fn;
    setSystemCursor = user32.func("__stdcall", "SetSystemCursor", "bool", ["void *", "uint32"]) as Fn;
    systemParametersInfoW = user32.func("__stdcall", "SystemParametersInfoW", "bool", [
      "uint32",
      "uint32",
      "void *",
      "uint32",
    ]) as Fn;
    return true;
  } catch {
    user32 = null;
    return false;
  }
}

// --- GDI+ (custom colored cursors) -----------------------------------------------------
// A separate, lazily-initialized binding set from user32's above — only loaded the first
// time a colored style is actually used, since most sessions never touch it.

const GdiplusStartupInputType = koffi.struct("GdiplusStartupInput", {
  GdiplusVersion: "uint32",
  DebugEventCallback: "void *",
  SuppressBackgroundThread: "int32",
  SuppressExternalCodecs: "int32",
});
const PointF = koffi.struct("PointF", { X: "float", Y: "float" });

const PIXEL_FORMAT_32BPP_ARGB = 0x0026200a;
const SMOOTHING_MODE_ANTIALIAS = 4;
const UNIT_PIXEL = 2;
const FILL_MODE_ALTERNATE = 0;

let gdiplus: ReturnType<typeof koffi.load> | null = null;
let gdipCreateBitmapFromScan0: Fn | null = null;
let gdipGetImageGraphicsContext: Fn | null = null;
let gdipSetSmoothingMode: Fn | null = null;
let gdipCreateSolidFill: Fn | null = null;
let gdipCreatePen1: Fn | null = null;
let gdipFillEllipse: Fn | null = null;
let gdipDrawEllipse: Fn | null = null;
let gdipFillPolygon: Fn | null = null;
let gdipDrawPolygon: Fn | null = null;
let gdipCreateHICONFromBitmap: Fn | null = null;
let gdipDeleteBrush: Fn | null = null;
let gdipDeletePen: Fn | null = null;
let gdipDeleteGraphics: Fn | null = null;
let gdipDisposeImage: Fn | null = null;

function bindGdiplus(): boolean {
  if (gdiplus) return true;
  try {
    gdiplus = koffi.load("gdiplus.dll");
    const startup = gdiplus.func("__stdcall", "GdiplusStartup", "int32", ["void *", "void *", "void *"]) as Fn;
    gdipCreateBitmapFromScan0 = gdiplus.func("__stdcall", "GdipCreateBitmapFromScan0", "int32", [
      "int32",
      "int32",
      "int32",
      "int32",
      "void *",
      "void *",
    ]) as Fn;
    gdipGetImageGraphicsContext = gdiplus.func("__stdcall", "GdipGetImageGraphicsContext", "int32", [
      "void *",
      "void *",
    ]) as Fn;
    gdipSetSmoothingMode = gdiplus.func("__stdcall", "GdipSetSmoothingMode", "int32", ["void *", "int32"]) as Fn;
    gdipCreateSolidFill = gdiplus.func("__stdcall", "GdipCreateSolidFill", "int32", ["uint32", "void *"]) as Fn;
    gdipCreatePen1 = gdiplus.func("__stdcall", "GdipCreatePen1", "int32", [
      "uint32",
      "float",
      "int32",
      "void *",
    ]) as Fn;
    gdipFillEllipse = gdiplus.func("__stdcall", "GdipFillEllipse", "int32", [
      "void *",
      "void *",
      "float",
      "float",
      "float",
      "float",
    ]) as Fn;
    gdipDrawEllipse = gdiplus.func("__stdcall", "GdipDrawEllipse", "int32", [
      "void *",
      "void *",
      "float",
      "float",
      "float",
      "float",
    ]) as Fn;
    gdipFillPolygon = gdiplus.func("__stdcall", "GdipFillPolygon", "int32", [
      "void *",
      "void *",
      koffi.pointer(PointF),
      "int32",
      "int32",
    ]) as Fn;
    gdipDrawPolygon = gdiplus.func("__stdcall", "GdipDrawPolygon", "int32", [
      "void *",
      "void *",
      koffi.pointer(PointF),
      "int32",
    ]) as Fn;
    gdipCreateHICONFromBitmap = gdiplus.func("__stdcall", "GdipCreateHICONFromBitmap", "int32", [
      "void *",
      "void *",
    ]) as Fn;
    gdipDeleteBrush = gdiplus.func("__stdcall", "GdipDeleteBrush", "int32", ["void *"]) as Fn;
    gdipDeletePen = gdiplus.func("__stdcall", "GdipDeletePen", "int32", ["void *"]) as Fn;
    gdipDeleteGraphics = gdiplus.func("__stdcall", "GdipDeleteGraphics", "int32", ["void *"]) as Fn;
    gdipDisposeImage = gdiplus.func("__stdcall", "GdipDisposeImage", "int32", ["void *"]) as Fn;

    const input = {
      GdiplusVersion: 1,
      DebugEventCallback: null,
      SuppressBackgroundThread: 0,
      SuppressExternalCodecs: 0,
    };
    const tokenBuf = Buffer.alloc(8);
    const status = startup(tokenBuf, koffi.as([input], koffi.pointer(GdiplusStartupInputType)), null);
    if (status !== 0) {
      gdiplus = null;
      return false;
    }
    // The startup token is never used again (no GdiplusShutdown call) — GDI+ stays
    // initialized for the app's lifetime, which Windows reclaims on process exit anyway.
    return true;
  } catch {
    gdiplus = null;
    return false;
  }
}

function outPtr(): { buf: Buffer; read: () => bigint } {
  const buf = Buffer.alloc(8);
  return { buf, read: () => buf.readBigUInt64LE(0) };
}

/** Draws a small colored shape onto a fresh transparent 32x32 bitmap and converts it to
 *  an owned cursor handle via GDI+. Returns null on any failure (missing bindings, a
 *  non-Ok GDI+ status) — callers just no-op in that case, same as every other style here
 *  when a lookup comes back empty. */
function createColoredCursor(shape: "arrow" | "dot", argb: number): bigint | null {
  if (!bindGdiplus()) return null;
  if (
    !gdipCreateBitmapFromScan0 ||
    !gdipGetImageGraphicsContext ||
    !gdipCreateSolidFill ||
    !gdipCreatePen1 ||
    !gdipCreateHICONFromBitmap ||
    !gdipDisposeImage
  ) {
    return null;
  }

  const SIZE = 32;
  const bmp = outPtr();
  if (gdipCreateBitmapFromScan0(SIZE, SIZE, 0, PIXEL_FORMAT_32BPP_ARGB, null, bmp.buf) !== 0) return null;

  const gfx = outPtr();
  if (gdipGetImageGraphicsContext(bmp.read(), gfx.buf) !== 0) {
    gdipDisposeImage(bmp.read());
    return null;
  }
  gdipSetSmoothingMode?.(gfx.read(), SMOOTHING_MODE_ANTIALIAS);

  const brush = outPtr();
  gdipCreateSolidFill(argb, brush.buf);
  const pen = outPtr();
  gdipCreatePen1(OUTLINE_ARGB, 1.5, UNIT_PIXEL, pen.buf);

  if (shape === "dot") {
    gdipFillEllipse?.(gfx.read(), brush.read(), 4, 4, 24, 24);
    gdipDrawEllipse?.(gfx.read(), pen.read(), 4, 4, 24, 24);
  } else if (gdipFillPolygon && gdipDrawPolygon) {
    // A classic arrow-cursor silhouette, tip at (2,2) — matching where a real arrow
    // cursor's hotspot sits, so the drawn tip is where clicks visually appear to land.
    const points = [
      { X: 2, Y: 2 },
      { X: 2, Y: 24 },
      { X: 8, Y: 19 },
      { X: 12, Y: 27 },
      { X: 15, Y: 25 },
      { X: 11, Y: 17 },
      { X: 18, Y: 17 },
    ];
    gdipFillPolygon(gfx.read(), brush.read(), points, points.length, FILL_MODE_ALTERNATE);
    gdipDrawPolygon(gfx.read(), pen.read(), points, points.length);
  }

  const hicon = outPtr();
  const status = gdipCreateHICONFromBitmap(bmp.read(), hicon.buf);

  gdipDeleteBrush?.(brush.read());
  gdipDeletePen?.(pen.read());
  gdipDeleteGraphics?.(gfx.read());
  gdipDisposeImage(bmp.read());

  return status === 0 ? hicon.read() : null;
}

// --- Applying styles ---------------------------------------------------------------

function reloadSystemCursors(): void {
  systemParametersInfoW?.(SPI_SETCURSORS, 0, null, SPIF_SENDCHANGE);
}

function applyOwnedCursor(owned: unknown): void {
  if (!owned || !setSystemCursor) return;
  setSystemCursor(owned, OCR_NORMAL);
}

function swapStockCursor(idcId: number): void {
  if (!loadCursorW || !copyIcon) return;
  const shared = loadCursorW(null, idcId);
  if (!shared) return;
  // SetSystemCursor takes ownership and destroys the handle it's given — LoadCursor's
  // handle is a shared system resource, not one we own, so it must be copied first.
  applyOwnedCursor(copyIcon(shared));
}

function swapFileCursor(filePath: string): void {
  if (!loadCursorFromFileW) return;
  // Unlike LoadCursorW, this already returns a handle we own — copied anyway for
  // consistency with swapStockCursor and to be safe about SetSystemCursor's ownership
  // requirements.
  const owned = loadCursorFromFileW(filePath);
  if (!owned || !copyIcon) return;
  applyOwnedCursor(copyIcon(owned));
}

/** Swaps the real system cursor for the recording's duration. A no-op for "default" and
 *  on non-Windows platforms. Persists a marker first (via settingsStore) so a crash
 *  mid-recording can still be cleaned up on next launch — see
 *  restorePendingCursorOverride(). */
export function applyCursorStyle(style: CursorHighlightStyle): void {
  if (style === "default" || !bind()) return;

  if (!getCursorOverride()) setCursorOverride(true);

  if (style === "hand") swapStockCursor(IDC_HAND);
  else if (style === "crosshair") swapStockCursor(IDC_CROSS);
  else if (style === "bigger") swapFileCursor(BIG_ARROW_FILE);
  else if (style === "huge") swapFileCursor(HUGE_ARROW_FILE);
  else if (style === "colorArrow") applyOwnedCursor(createColoredCursor("arrow", COLOR_ARROW_ARGB));
  else if (style === "colorHand") applyOwnedCursor(createColoredCursor("dot", COLOR_HAND_ARGB));
}

/** Restores whatever the cursor looked like before `applyCursorStyle` — safe to call even
 *  when no override is active (e.g. the recording never touched the cursor). */
export function restoreCursor(): void {
  if (!getCursorOverride()) return;
  if (bind()) reloadSystemCursors();
  clearCursorOverride();
}

/** Called once at app startup: if a previous session left the cursor overridden (e.g. it
 *  crashed mid-recording instead of reaching the normal stop() cleanup), put it back. */
export function restorePendingCursorOverride(): void {
  restoreCursor();
}
