/**
 * True physical-pixel monitor rectangles, for cropping ffmpeg's gdigrab capture to a
 * single display (see native/screenCapture.ts). Electron's own `screen.getAllDisplays()`
 * reports bounds in DIPs (CSS-pixel-equivalent, post-DPI-scaling) — fine for UI layout, but
 * gdigrab's `-offset_x/-offset_y/-video_size` need real physical pixels, and on a
 * mixed-DPI multi-monitor system the two spaces don't relate by a simple per-display
 * multiply: Chromium's DIP layout algorithm can place a secondary monitor at a DIP offset
 * that doesn't correspond to its true physical position (verified empirically on a
 * 100%/125% dual-monitor setup — naively multiplying DIP bounds by scaleFactor put the
 * crop region entirely on the wrong monitor).
 *
 * EnumDisplayMonitors/GetMonitorInfoW give the physical answer directly, but only when the
 * *calling process* is DPI-aware — Electron's main process is (Chromium declares
 * Per-Monitor-V2 awareness), so calling this from here is safe. A plain, unmanifested
 * child process is not guaranteed to be, which is part of why this lives in the main
 * process rather than being computed once and handed to a worker.
 */
// Loaded lazily, only once bind() has confirmed we're on win32 — koffi ships a native
// addon per platform/arch, and this whole module is Windows-only, so importing it
// unconditionally at the top level would make every platform pay to load (and bundle) a
// native binary purely to satisfy a require() that's never actually used off Windows.
import type { TypeObject, LibraryHandle } from "koffi";

const MONITORINFOF_PRIMARY = 0x1;

type Fn = (...args: unknown[]) => unknown;
type KoffiModule = typeof import("koffi");

let koffi: KoffiModule | null = null;
let MONITORINFO: TypeObject | null = null;
let user32: LibraryHandle | null = null;
let monitorEnumProc: TypeObject | null = null;
let enumDisplayMonitors: Fn | null = null;
let getMonitorInfoW: Fn | null = null;

function bind(): boolean {
  if (process.platform !== "win32") return false;
  if (user32) return true;
  try {
    koffi = require("koffi") as KoffiModule;
    const RECT = koffi.struct("RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
    MONITORINFO = koffi.struct("MONITORINFO", {
      cbSize: "uint32",
      rcMonitor: RECT,
      rcWork: RECT,
      dwFlags: "uint32",
    });
    user32 = koffi.load("user32.dll");
    monitorEnumProc = koffi.proto("bool __stdcall MonitorEnumProc(void *, void *, void *, intptr_t)");
    enumDisplayMonitors = user32.func("__stdcall", "EnumDisplayMonitors", "bool", [
      "void *",
      "void *",
      koffi.pointer(monitorEnumProc),
      "intptr_t",
    ]) as Fn;
    // cbSize must travel INTO the call (GetMonitorInfoW requires it pre-set) as well as
    // back out, hence inout rather than plain out.
    getMonitorInfoW = user32.func("__stdcall", "GetMonitorInfoW", "bool", [
      "void *",
      koffi.inout(koffi.pointer(MONITORINFO)),
    ]) as Fn;
    return true;
  } catch {
    user32 = null;
    return false;
  }
}

export interface PhysicalMonitor {
  rect: { x: number; y: number; width: number; height: number };
  primary: boolean;
}

/** Empty on non-Windows or if the native calls aren't available — callers fall back to
 *  DIP-based bounds in that case (see screenCapture.ts). */
interface MonitorInfoOut {
  cbSize: number;
  rcMonitor: { left: number; top: number; right: number; bottom: number };
  dwFlags: number;
}

export function listPhysicalMonitors(): PhysicalMonitor[] {
  if (!bind() || !enumDisplayMonitors || !getMonitorInfoW || !monitorEnumProc) return [];
  // bind() having returned true guarantees koffi/MONITORINFO are populated.
  const k = koffi as KoffiModule;
  const monitorInfo = MONITORINFO as TypeObject;
  const getInfo = getMonitorInfoW;
  const proto = monitorEnumProc;

  const results: PhysicalMonitor[] = [];
  const callback = k.register((hMonitor: unknown) => {
    const info: MonitorInfoOut = { cbSize: k.sizeof(monitorInfo), rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 }, dwFlags: 0 };
    if (getInfo(hMonitor, info)) {
      const r = info.rcMonitor;
      results.push({
        rect: { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top },
        primary: (info.dwFlags & MONITORINFOF_PRIMARY) !== 0,
      });
    }
    return true;
  }, k.pointer(proto));

  try {
    enumDisplayMonitors(null, null, callback, 0);
  } finally {
    k.unregister(callback);
  }
  return results;
}
