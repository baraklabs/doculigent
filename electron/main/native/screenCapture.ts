import { app, desktopCapturer, screen } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import ffmpegStaticPath from "ffmpeg-static";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";
import type { AreaRect } from "@shared/types/models";
import { listPhysicalMonitors, type PhysicalMonitor } from "./monitors";
import { logNative } from "./nativeLog";

const ffmpegPath = (ffmpegStaticPath ?? "ffmpeg").replace("app.asar", "app.asar.unpacked");

const FPS = 30;

interface Segment {
  proc: ChildProcess;
  outputPath: string;
}

// The ffmpeg-driven backend (gdigrab on Windows, avfoundation on macOS as a fallback —
// see ScreenCaptureKitCapture below for macOS's primary path).
interface FfmpegCapture {
  kind: "ffmpeg";
  hideCursor: boolean;
  isArea: boolean;
  current: Segment | null;
  segments: string[];
  // Windows (gdigrab) — precise physical-pixel rect resolved once at start; gdigrab
  // captures exactly this rect at the source via -offset_x/-offset_y/-video_size.
  winRect?: { x: number; y: number; width: number; height: number };
  // macOS (avfoundation) — a device index plus the fractional (0..1) area rect, cropped
  // via -vf at encode time instead: unlike gdigrab, avfoundation can only capture a whole
  // display, not an arbitrary sub-rectangle at the source.
  macDeviceIndex?: number;
  macArea?: AreaRect | null;
}

// macOS's primary native backend — a compiled Swift helper (electron/native/mac/
// ScreenCaptureKitRecorder.swift) using ScreenCaptureKit instead of ffmpeg's avfoundation
// input. See that file's header comment for why: avfoundation's legacy CGDisplayStream
// capture doesn't reliably respect win.setContentProtection(true) (confirmed — the camera
// bubble window still showed up baked into the recording), while ScreenCaptureKit
// excludes sharingType=.none windows automatically. Falls back to the avfoundation path
// (FfmpegCapture above) if the helper hasn't been built for this machine (see
// scripts/build-mac-screencapturekit-helper.mjs — requires Xcode Command Line Tools, so
// isn't run automatically).
interface SckCapture {
  kind: "sck";
  proc: ChildProcess;
  outputPath: string;
}

// Windows' native backend for Quick Recording — a compiled Rust helper (electron/native/
// windows/capture-helper) using Windows.Graphics.Capture instead of ffmpeg's gdigrab. Why:
// gdigrab's -draw_mouse polls GetCursorInfo/GDI independently of the frame capture, racing
// DWM's hardware cursor compositor — confirmed visible flicker, both live on-screen and in
// the recording, a structural limitation no flag fixes. WGC composites the cursor as part
// of the same frame the compositor already produces, so there's nothing to poll or race.
// Only used for Quick mode (mode param below) — Advanced keeps gdigrab always, since it
// hides the cursor and tracks it separately for editable overlay and has no flicker
// complaint. Falls back to gdigrab if the helper hasn't been built (see
// scripts/build-windows-capture-helper.mjs — requires a Rust toolchain, so isn't run
// automatically) or if monitor resolution fails.
//
// Segment/pause-resume shape matches FfmpegCapture deliberately: unlike the SCK helper
// (which pauses/resumes in-process via stdin commands), this helper's own protocol only
// ever runs one uninterrupted recording per launch — pause stops the current helper
// process cleanly (via a "stop\n" stdin command, see finishWgcSegment), resume spawns a
// fresh one, and the final stop concats all segments with concatSegments, exactly like
// gdigrab's own pause/resume today.
interface WgcCapture {
  kind: "wgc";
  monitorIndex: number;
  showCursor: boolean;
  areaX?: number;
  areaY?: number;
  areaWidth?: number;
  areaHeight?: number;
  current: Segment | null;
  segments: string[];
}

// Linux's native backend for Quick Recording — a compiled Rust helper (electron/native/
// linux/capture-helper) using PipeWire via the xdg-desktop-portal ScreenCast interface.
// UNVERIFIED (see that crate's src/main.rs header comment — written with no Linux
// environment available to build or test against). Mirrors SckCapture's shape (a single
// long-lived process, pause/resume handled in-process via stdin rather than
// FfmpegCapture/WgcCapture's segment-per-pause model) rather than gdigrab/WGC's — re-
// running the portal permission handshake on every resume would re-show its picker
// dialog each time, which the in-process approach avoids. Falls back to the existing
// getDisplayMedia pipeline (Linux's only capture path before this) if the helper hasn't
// been built or fails to start — see scripts/build-linux-capture-helper.mjs.
interface PipeWireCapture {
  kind: "pipewire";
  proc: ChildProcess;
  outputPath: string;
}

type ActiveCapture = FfmpegCapture | SckCapture | WgcCapture | PipeWireCapture;

let active: ActiveCapture | null = null;

/** Wall-clock -> recorded-timeline mapping for the capture that is, or just was, running.
 *
 *  The screen recording's own t=0 is the instant its backend captured its first frame,
 *  which is emphatically not when the renderer considers the recording started: the
 *  capture backend is spawned first, and camera/mic acquisition (getUserMedia, hundreds of
 *  ms to seconds) happens after it, before the cursor/camera trackers are even started.
 *  Paused spans don't exist in the recorded file at all, either. So a tracker timestamping
 *  its own samples against its own start, in wall-clock ms, drifts ahead of the picture by
 *  that startup gap plus every pause -- which is exactly the synthetic cursor arriving at
 *  the drop point before the window it is supposedly dragging does.
 *
 *  Trackers (native/cursorTrack.ts, native/cameraTrack.ts) therefore keep raw Date.now()
 *  timestamps while recording and convert them through captureTimelineMs() when they
 *  serialize, once the capture has stopped and the whole mapping is known. Deliberately
 *  NOT cleared by stopScreenCapture: cursor.json/camera.json are written after it (see
 *  registerRecordingIpc's save handler) and still have to resolve against it. The next
 *  startScreenCapture resets it instead. */
interface CaptureClock {
  /** Date.now() at the first captured frame; null until a backend reports capturing. */
  startedAt: number | null;
  /** Wall-clock spans absent from the recording because it was paused. `to` stays null
   *  while still paused. */
  pauses: { from: number; to: number | null }[];
}

let clock: CaptureClock = { startedAt: null, pauses: [] };

function clockReset(): void {
  clock = { startedAt: null, pauses: [] };
}

/** Called the moment a backend actually starts producing frames: the first call fixes the
 *  recording's t=0, later ones close the pause span whose resume just landed. */
function clockCapturing(): void {
  const now = Date.now();
  if (clock.startedAt === null) {
    clock.startedAt = now;
    return;
  }
  const open = clock.pauses[clock.pauses.length - 1];
  if (open && open.to === null) open.to = now;
}

function clockPaused(): void {
  if (clock.startedAt === null) return;
  const open = clock.pauses[clock.pauses.length - 1];
  if (open && open.to === null) return;
  clock.pauses.push({ from: Date.now(), to: null });
}

/** Date.now() of the recording's first captured frame, or null when no native capture ran
 *  (a window target, or any platform/backend that fell back to getDisplayMedia). Trackers
 *  read null as "this recording has a real cursor baked into its pixels, don't write a
 *  synthetic track for it" -- the same condition recordMeta.json's cursorBakedIn records. */
export function captureStartedAt(): number | null {
  return clock.startedAt;
}

/** Maps a wall-clock instant onto the recorded video's own timeline, in ms from its first
 *  frame. Null when no frame exists for that instant at all: before capture started, or
 *  inside a paused span. */
export function captureTimelineMs(at: number): number | null {
  if (clock.startedAt === null || at < clock.startedAt) return null;
  let pausedBefore = 0;
  for (const pause of clock.pauses) {
    if (at < pause.from) break;
    if (pause.to === null || at < pause.to) return null;
    pausedBefore += pause.to - pause.from;
  }
  return at - clock.startedAt - pausedBefore;
}

// Returns both the matched monitor's rect (for gdigrab's -offset_x/-offset_y/-video_size)
// and its 0-based index within `monitors` (for WGC's Monitor::from_index — the Rust
// helper enumerates via the identical EnumDisplayMonitors Win32 call listPhysicalMonitors
// uses, in the same order, so this index is directly usable there, 1-based).
function matchPhysicalMonitor(
  display: Electron.Display,
  monitors: PhysicalMonitor[]
): { monitor: PhysicalMonitor; index: number } | null {
  const expectedW = Math.round(display.bounds.width * display.scaleFactor);
  const expectedH = Math.round(display.bounds.height * display.scaleFactor);
  const isPrimaryDisplay = display.id === screen.getPrimaryDisplay().id;

  const candidates = monitors
    .map((monitor, index) => ({ monitor, index }))
    .filter(({ monitor: m }) => Math.abs(m.rect.width - expectedW) <= 2 && Math.abs(m.rect.height - expectedH) <= 2);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    return candidates.find(({ monitor: m }) => m.primary === isPrimaryDisplay) ?? candidates[0];
  }
  if (!isPrimaryDisplay) return null;
  const primaryIndex = monitors.findIndex((m) => m.primary);
  return primaryIndex >= 0 ? { monitor: monitors[primaryIndex], index: primaryIndex } : null;
}

async function resolveMonitor(targetId: string): Promise<{ rect: PhysicalMonitor["rect"]; index: number } | null> {
  const sources = await desktopCapturer.getSources({ types: ["screen"] });
  const source = sources.find((s) => s.id === targetId);
  if (!source) return null;
  const display =
    screen.getAllDisplays().find((d) => String(d.id) === source.display_id) ?? screen.getPrimaryDisplay();

  const monitors = listPhysicalMonitors();
  if (monitors.length === 0) return null;
  const match = matchPhysicalMonitor(display, monitors);
  return match ? { rect: match.monitor.rect, index: match.index } : null;
}

async function resolveDisplayRect(targetId: string): Promise<PhysicalMonitor["rect"] | null> {
  const resolved = await resolveMonitor(targetId);
  return resolved?.rect ?? null;
}

// macOS equivalent of listPhysicalMonitors — avfoundation exposes screens as numbered
// "video devices" ("Capture screen 0", "Capture screen 1", ...) rather than through any
// queryable display-id API, so the only way to find their indices is asking ffmpeg
// itself via -list_devices and parsing the device list it prints to stderr.
async function listAvfoundationScreenIndices(): Promise<number[]> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const finish = (indices: number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(indices);
    };
    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill();
      finish([]);
    }, 5000);
    proc.once("error", () => finish([]));
    proc.once("close", () => {
      const indices: number[] = [];
      const re = /\[(\d+)\]\s+Capture screen/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stderr))) indices.push(Number(m[1]));
      console.log("[screenCapture] avfoundation screen devices", { indices });
      finish(indices);
    });
  });
}

/** Maps a desktopCapturer "screen:..." targetId to the avfoundation device index that
 *  captures the same physical display. There's no documented API correlating the two —
 *  this assumes avfoundation's screen-device enumeration order matches
 *  screen.getAllDisplays() with the primary display first, which holds for the common
 *  single/dual-monitor cases but isn't a guaranteed mapping on more exotic multi-monitor
 *  setups. The single-display case (by far the most common) is unambiguous regardless. */
async function resolveMacScreenDeviceIndex(targetId: string): Promise<number | null> {
  const sources = await desktopCapturer.getSources({ types: ["screen"] });
  const source = sources.find((s) => s.id === targetId);
  if (!source) return null;
  const displays = screen.getAllDisplays();
  const display = displays.find((d) => String(d.id) === source.display_id) ?? screen.getPrimaryDisplay();

  const screenIndices = await listAvfoundationScreenIndices();
  if (screenIndices.length === 0) return null;
  if (screenIndices.length === 1) return screenIndices[0];

  const primary = screen.getPrimaryDisplay();
  const ordered = [primary, ...displays.filter((d) => d.id !== primary.id)];
  const position = ordered.findIndex((d) => d.id === display.id);
  return position >= 0 && position < screenIndices.length ? screenIndices[position] : screenIndices[0];
}

/** Whether the currently active capture backend reliably excludes a
 *  sharingType/setContentProtection'd window (the camera bubble) on its own — Windows'
 *  gdigrab native path (proven reliable) and macOS's ScreenCaptureKit path (also proven
 *  reliable — it excludes sharingType=.none windows automatically, see
 *  ScreenCaptureKitRecorder.swift's header comment), but NOT macOS's avfoundation fallback
 *  (confirmed unreliable — a camera bubble ended up baked into the recording even with
 *  setContentProtection(true) set) or the Chromium getDisplayMedia fallback on any
 *  platform. Callers use this to decide whether cameraBubbleWindow.ts needs to hide the
 *  bubble outright for the recording's duration instead of trusting the OS to exclude it. */
export function isCaptureContentProtected(): boolean {
  if (!active) return false;
  if (process.platform === "win32") return active.kind === "ffmpeg" || active.kind === "wgc";
  if (process.platform === "darwin") return active.kind === "sck";
  return false;
}

export function canCaptureTarget(targetId: string): boolean {
  // Only whole-display targets — neither gdigrab/WGC nor avfoundation/SCK can capture a
  // single window the way desktopCapturer's window sources can, so "window:..." targets
  // always fall back to the getDisplayMedia-based pipeline on every platform. Linux is
  // included here only for the PipeWire helper (Quick mode) — see startScreenCapture's
  // linux branch, which returns false itself (no gdigrab-equivalent fallback exists on
  // Linux) if that helper is missing or fails to start.
  return (
    (process.platform === "win32" || process.platform === "darwin" || process.platform === "linux") &&
    targetId.startsWith("screen:")
  );
}

export function vfFor(isArea: boolean): string {
  return isArea
    ? "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"
    : `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
        `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`;
}

const SCK_HELPER_NAME = "doculigent-screencapturekit-helper";

/** Resolves the compiled ScreenCaptureKit helper for this machine's arch, or null if it
 *  hasn't been built (see scripts/build-mac-screencapturekit-helper.mjs) — callers treat
 *  null as "fall back to the avfoundation-based FfmpegCapture path", never as an error. */
async function resolveScreenCaptureKitHelperPath(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  // A single lipo-merged universal binary (see scripts/build-mac-screencapturekit-helper.mjs
  // for why) — no per-arch subfolder to pick between at runtime.
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "native-bin", SCK_HELPER_NAME)
    : path.join(app.getAppPath(), "electron", "native", "mac", "bin", SCK_HELPER_NAME);
  try {
    await fs.access(candidate);
    logNative(`ScreenCaptureKit helper found at ${candidate}`);
    return candidate;
  } catch {
    logNative(`ScreenCaptureKit helper NOT found at ${candidate} — will fall back to avfoundation`);
    return null;
  }
}

interface SckCaptureConfig {
  fps: number;
  displayId: number;
  outputPath: string;
  areaX?: number;
  areaY?: number;
  areaWidth?: number;
  areaHeight?: number;
  /** Requires ScreenCaptureKitRecorder.swift to read this field and set
   *  streamConfig.showsCursor accordingly (currently hardcoded false there) — until the
   *  native helper is rebuilt with that change, this is sent but has no effect. */
  showsCursor?: boolean;
}

/** Spawns the helper and waits for its "Recording started" stdout line (mirrors the
 *  handshake the reference ScreenCaptureKit-based recorder this was adapted from uses) —
 *  a null return means the helper failed to start (bad permissions, display not found,
 *  etc.), in which case the caller falls back to the avfoundation path. */
function startScreenCaptureKitCapture(helperPath: string, config: SckCaptureConfig): Promise<SckCapture | null> {
  console.log("[screenCapture] starting ScreenCaptureKit helper", { helperPath });
  const proc = spawn(helperPath, [JSON.stringify(config)], { stdio: ["pipe", "pipe", "pipe"] });
  let stdoutBuf = "";
  let stderrBuf = "";
  proc.stdout?.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
  });
  proc.on("error", (error) => {
    console.error("[screenCapture] native helper spawn error", error);
    logNative(`ScreenCaptureKit helper spawn error: ${error}`);
  });
  proc.on("exit", (code, signal) => {
    console.log("[screenCapture] native helper exited", { code, signal });
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off("data", onStdout);
      if (!ok) {
        const detail = stderrBuf.slice(-1000) || stdoutBuf.slice(-1000);
        console.error("[screenCapture] ScreenCaptureKit helper failed to start:", detail);
        logNative(`ScreenCaptureKit helper FAILED to start: ${detail}`);
        if (!proc.killed) proc.kill();
        resolve(null);
      } else {
        logNative(`ScreenCaptureKit helper loaded and started (pid ${proc.pid})`);
        proc.once("exit", (code) => {
          if (code !== 0 && code !== null) {
            console.error(`[screenCapture] ScreenCaptureKit helper exited ${code}:`, stderrBuf.slice(-1000));
            logNative(`ScreenCaptureKit helper exited ${code}: ${stderrBuf.slice(-1000)}`);
          }
        });
        resolve({ kind: "sck", proc, outputPath: config.outputPath });
      }
    };
    const onStdout = () => {
      if (stdoutBuf.includes("Recording started")) finish(true);
    };
    const timer = setTimeout(() => finish(false), 12000);
    proc.stdout?.on("data", onStdout);
    proc.once("error", () => finish(false));
    proc.once("exit", () => finish(false));
  });
}

const WGC_HELPER_NAME = "doculigent-wgc-helper.exe";

/** Resolves the compiled Windows.Graphics.Capture helper, or null if it hasn't been built
 *  (see scripts/build-windows-capture-helper.mjs) — callers treat null as "fall back to
 *  the gdigrab-based path", never as an error, same shape as
 *  resolveScreenCaptureKitHelperPath above. */
async function resolveWindowsCaptureHelperPath(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "native-bin", WGC_HELPER_NAME)
    : path.join(app.getAppPath(), "electron", "native", "windows", "bin", WGC_HELPER_NAME);
  try {
    await fs.access(candidate);
    logNative(`WGC helper found at ${candidate}`);
    return candidate;
  } catch {
    logNative(`WGC helper NOT found at ${candidate} — will fall back to gdigrab`);
    return null;
  }
}

interface WgcHelperConfig {
  monitorIndex: number;
  outputPath: string;
  fps: number;
  showCursor: boolean;
  areaX?: number;
  areaY?: number;
  areaWidth?: number;
  areaHeight?: number;
}

/** Spawns the WGC helper for one segment and waits for its "Recording started" stdout
 *  line — mirrors startScreenCaptureKitCapture's handshake, but returns a plain Segment
 *  (proc + outputPath) so pauseScreenCapture/resumeScreenCapture/stopScreenCapture can
 *  reuse the exact same segments[]/concatSegments flow gdigrab already uses. A null
 *  return means the helper failed to start, in which case the caller falls back to
 *  gdigrab (only relevant on the very first segment — see startScreenCapture). */
function spawnWgcSegment(helperPath: string, capture: WgcCapture): Promise<Segment | null> {
  const outputPath = path.join(os.tmpdir(), `doculigent-screen-${randomUUID()}.mp4`);
  const config: WgcHelperConfig = {
    monitorIndex: capture.monitorIndex,
    outputPath,
    fps: FPS,
    showCursor: capture.showCursor,
    areaX: capture.areaX,
    areaY: capture.areaY,
    areaWidth: capture.areaWidth,
    areaHeight: capture.areaHeight,
  };

  const proc = spawn(helperPath, [JSON.stringify(config)], { stdio: ["pipe", "pipe", "pipe"] });
  let stdoutBuf = "";
  let stderrBuf = "";
  proc.stdout?.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
  });
  proc.on("error", (error) => {
    console.error("[screenCapture] WGC helper spawn error", error);
    logNative(`WGC helper spawn error: ${error}`);
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off("data", onStdout);
      if (!ok) {
        const detail = stderrBuf.slice(-1000) || stdoutBuf.slice(-1000);
        console.error("[screenCapture] WGC helper failed to start:", detail);
        logNative(`WGC helper FAILED to start: ${detail}`);
        if (!proc.killed) proc.kill();
        resolve(null);
      } else {
        logNative(`WGC helper started (pid ${proc.pid})`);
        proc.once("close", (code) => {
          if (code !== 0 && code !== null) {
            console.error(`[screenCapture] WGC helper exited ${code}:`, stderrBuf.slice(-1000));
            logNative(`WGC helper exited ${code}: ${stderrBuf.slice(-1000)}`);
          }
        });
        resolve({ proc, outputPath });
      }
    };
    const onStdout = () => {
      if (stdoutBuf.includes("Recording started")) finish(true);
    };
    const timer = setTimeout(() => finish(false), 12000);
    proc.stdout?.on("data", onStdout);
    proc.once("error", () => finish(false));
    proc.once("exit", () => finish(false));
  });
}

/** Stops one WGC helper segment cleanly via its "stop\n" stdin command (not "q" — that's
 *  gdigrab/ffmpeg's quit key, the WGC helper reads line-based commands, see
 *  capture-helper/src/main.rs). Finalizing the MP4 requires this graceful stop — a hard
 *  kill (the 5s fallback below) leaves the file unfinalized/corrupt, so the timeout here
 *  exists only as a safety net, not the expected path. */
async function finishWgcSegment(segment: Segment): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    segment.proc.once("close", finish);
    const timer = setTimeout(() => {
      if (!segment.proc.killed) segment.proc.kill();
      finish();
    }, 5000);
    segment.proc.stdin?.write("stop\n");
    segment.proc.stdin?.end();
  });
}

const PIPEWIRE_HELPER_NAME = "doculigent-pipewire-helper";

/** Resolves the compiled PipeWire helper, or null if it hasn't been built (see
 *  scripts/build-linux-capture-helper.mjs) — same fallback shape as the other two
 *  helpers' resolve functions. UNVERIFIED end to end, see capture-helper/src/main.rs. */
async function resolveLinuxCaptureHelperPath(): Promise<string | null> {
  if (process.platform !== "linux") return null;
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "native-bin", PIPEWIRE_HELPER_NAME)
    : path.join(app.getAppPath(), "electron", "native", "linux", "bin", PIPEWIRE_HELPER_NAME);
  try {
    await fs.access(candidate);
    logNative(`PipeWire helper found at ${candidate}`);
    return candidate;
  } catch {
    logNative(`PipeWire helper NOT found at ${candidate} — will fall back to getDisplayMedia`);
    return null;
  }
}

/** Spawns the PipeWire helper and waits for its "Recording started" stdout line — same
 *  handshake shape as startScreenCaptureKitCapture. The helper needs the bundled ffmpeg
 *  binary's path itself (it has no built-in encoder, unlike WGC/SCK — see main.rs). */
function startPipeWireCapture(helperPath: string, outputPath: string, fps: number): Promise<PipeWireCapture | null> {
  const config = { outputPath, fps, ffmpegPath: ffmpegPath };
  console.log("[screenCapture] starting PipeWire helper", { helperPath, config });
  const proc = spawn(helperPath, [JSON.stringify(config)], { stdio: ["pipe", "pipe", "pipe"] });
  let stdoutBuf = "";
  let stderrBuf = "";
  proc.stdout?.on("data", (d: Buffer) => {
    stdoutBuf += d.toString();
  });
  proc.stderr?.on("data", (d: Buffer) => {
    stderrBuf += d.toString();
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
  });
  proc.on("error", (error) => {
    console.error("[screenCapture] PipeWire helper spawn error", error);
    logNative(`PipeWire helper spawn error: ${error}`);
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off("data", onStdout);
      if (!ok) {
        const detail = stderrBuf.slice(-1000) || stdoutBuf.slice(-1000);
        console.error("[screenCapture] PipeWire helper failed to start:", detail);
        logNative(`PipeWire helper FAILED to start: ${detail}`);
        if (!proc.killed) proc.kill();
        resolve(null);
      } else {
        logNative(`PipeWire helper started (pid ${proc.pid})`);
        proc.once("exit", (code) => {
          if (code !== 0 && code !== null) {
            console.error(`[screenCapture] PipeWire helper exited ${code}:`, stderrBuf.slice(-1000));
            logNative(`PipeWire helper exited ${code}: ${stderrBuf.slice(-1000)}`);
          }
        });
        resolve({ kind: "pipewire", proc, outputPath });
      }
    };
    const onStdout = () => {
      if (stdoutBuf.includes("Recording started")) finish(true);
    };
    // Longer than the other two helpers' 12s — this one involves an interactive portal
    // permission dialog the user has to click through, not just native init.
    const timer = setTimeout(() => finish(false), 60000);
    proc.stdout?.on("data", onStdout);
    proc.once("error", () => finish(false));
    proc.once("exit", () => finish(false));
  });
}

function winArgs(capture: FfmpegCapture, outputPath: string): string[] {
  const rect = capture.winRect!;
  return [
    "-y",
    "-f",
    "gdigrab",
    "-draw_mouse",
    capture.hideCursor ? "0" : "1",
    "-framerate",
    String(FPS),
    "-offset_x",
    String(rect.x),
    "-offset_y",
    String(rect.y),
    "-video_size",
    `${rect.width}x${rect.height}`,
    "-i",
    "desktop",
    "-vf",
    vfFor(capture.isArea),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    outputPath,
  ];
}

function macArgs(capture: FfmpegCapture, outputPath: string): string[] {
  // avfoundation captures a whole display only, so an area recording is cropped via -vf
  // using the same fractional (0..1) formula as the getDisplayMedia fallback path in
  // ipc/recording.ts's buildFinalMp4 — no physical-pixel rect resolution needed here at
  // all, unlike gdigrab. -capture_cursor is avfoundation's equivalent of gdigrab's
  // -draw_mouse: it excludes the real cursor at the capture source rather than relying on
  // (unreliable, per displayMedia.ts) browser-level cursor suppression.
  const area = capture.macArea;
  const vf = area
    ? `crop=iw*${area.width}:ih*${area.height}:iw*${area.x}:ih*${area.y},${vfFor(true)}`
    : vfFor(false);
  return [
    "-y",
    "-f",
    "avfoundation",
    "-capture_cursor",
    capture.hideCursor ? "0" : "1",
    "-framerate",
    String(FPS),
    "-i",
    `${capture.macDeviceIndex}:none`,
    "-vf",
    vf,
    // avfoundation's screen device only delivers a new frame when content actually
    // changes, not on a steady clock — without this, ffmpeg forces constant-framerate
    // output by duplicating the last frame to fill the gap, which for a mostly-static
    // screen can run away entirely (confirmed — a short recording produced 30000+
    // duplicated frames and took real minutes to encode, "More than 1000 frames
    // duplicated" in stderr). -fps_mode vfr passes the real, variable frame timestamps
    // through instead of forcing a duplicated 30fps stream; overlayCameraBubble/
    // overlayCursorTrack already position by elapsed time (`t`), not frame count, so VFR
    // input doesn't break sync with the camera/cursor tracks.
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    // A plain mp4 muxer only writes its moov atom (the index/trailer that makes the file
    // readable at all) once ffmpeg exits cleanly. finishSegment's stdin "q" isn't landing
    // reliably enough here (confirmed — segments were coming out as truncated files with
    // no moov atom, "Invalid data found when processing input" downstream), so this
    // process sometimes only stops via finishSegment's 5s hard-kill fallback instead.
    // frag_keyframe+empty_moov writes an upfront empty moov plus periodic fragments as
    // capture proceeds, so the file stays a valid, playable mp4 even if the process is
    // killed mid-recording rather than exiting gracefully.
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    outputPath,
  ];
}

/** `onCapturing` fires when this segment's ffmpeg has actually opened the capture device
 *  and is about to pull frames from it. Anchored on the "Input #0, gdigrab/avfoundation"
 *  header because ffmpeg only prints that once the device is open, which puts it within a
 *  frame or two of the recording's real t=0. The `spawn` event is not: process launch plus
 *  device init is 100-300ms of video that doesn't exist yet, and anything timestamped
 *  against it lands that far ahead of the picture. */
/** Resolves only once ffmpeg is actually capturing (its "Input #0" header, or the 4s
 *  fallback below), not merely spawned — the caller (startScreenCapture/
 *  resumeScreenCapture) awaits this before returning `true`/anchoring downstream state, so
 *  resolving early on process "spawn" let `captureStartedAt()` still read null at that
 *  point (process launch plus device init is 100-300ms ffmpeg needs before it's even
 *  opened the capture device, well before "Input #0" prints). Confirmed live: every
 *  recording using this path had EditProjectMedia.sideClipStartOffsetMs come back null,
 *  because RecordingService reads screenCapture.start()'s startedAtMs synchronously right
 *  after the call resolves — exactly the window this raced. */
function spawnSegment(capture: FfmpegCapture, onCapturing: () => void): Promise<Segment | null> {
  const outputPath = path.join(os.tmpdir(), `doculigent-screen-${randomUUID()}.mp4`);
  const args = process.platform === "darwin" ? macArgs(capture, outputPath) : winArgs(capture, outputPath);

  const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.once("close", (code) => {
    if (code !== 0 && code !== null) console.error(`[screenCapture] ffmpeg segment exited ${code}:`, stderr.slice(-1000));
  });

  return new Promise((resolve) => {
    let settled = false;
    let capturing = false;
    const segment: Segment = { proc, outputPath };
    const finish = (result: Segment | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(anchorTimer);
      resolve(result);
    };
    const markCapturing = () => {
      if (capturing) return;
      capturing = true;
      onCapturing();
      finish(segment);
    };
    // Safety net only. ffmpeg always prints that header at its default log level (no
    // -loglevel is passed anywhere here), so this firing at all means something is badly
    // wrong with the capture -- log it and still resolve successfully (the segment/process
    // itself may be fine) rather than let the trackers silently write nothing forever.
    const anchorTimer = setTimeout(() => {
      if (capturing) return;
      logNative("[screenCapture] ffmpeg never printed its input header - capture clock anchored late");
      markCapturing();
    }, 4000);
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.includes("Input #0")) markCapturing();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    proc.once("error", () => finish(null));
    // Died before ever reaching "Input #0"/the 4s fallback -- a real failure, not just the
    // ordinary end-of-segment close finishSegment/finishWgcSegment trigger (which only ever
    // happens after this promise has already settled with a real segment).
    proc.once("exit", () => finish(null));
  });
}

async function finishSegment(segment: Segment): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    segment.proc.once("close", finish);
    const timer = setTimeout(() => {
      if (!segment.proc.killed) segment.proc.kill();
      finish();
    }, 5000);
    segment.proc.stdin?.write("q");
    segment.proc.stdin?.end();
  });
}

async function concatSegments(segmentPaths: string[]): Promise<string> {
  const listPath = path.join(os.tmpdir(), `doculigent-concat-${randomUUID()}.txt`);
  const listContents = segmentPaths
    .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listPath, listContents, "utf8");

  const outputPath = path.join(os.tmpdir(), `doculigent-screen-${randomUUID()}.mp4`);
  const args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.once("error", reject);
    proc.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`concat exited ${code}`))));
  });

  await fs.unlink(listPath).catch(() => {});
  for (const p of segmentPaths) await fs.unlink(p).catch(() => {});
  return outputPath;
}

/** Electron's Display.id is documented as the platform display identifier, which on
 *  macOS is the CGDirectDisplayID ScreenCaptureKit's APIs expect directly. */
async function resolveMacDisplayId(targetId: string): Promise<number | null> {
  const sources = await desktopCapturer.getSources({ types: ["screen"] });
  const source = sources.find((s) => s.id === targetId);
  if (!source) return null;
  const display =
    screen.getAllDisplays().find((d) => String(d.id) === source.display_id) ?? screen.getPrimaryDisplay();
  return display.id;
}

export async function startScreenCapture(
  targetId: string,
  hideCursor: boolean,
  area?: AreaRect,
  mode: "quick" | "advanced" = "advanced"
): Promise<boolean> {
  if (active) return false;
  // Reset before the canCaptureTarget bail-out, not after: a window target (or any other
  // target no native backend can capture) records through the getDisplayMedia fallback
  // instead, and the clock has to read as "no native capture" for this recording rather
  // than still holding the previous one's mapping.
  clockReset();
  if (!canCaptureTarget(targetId)) return false;

  if (process.platform === "win32" && mode === "quick") {
    const helperPath = await resolveWindowsCaptureHelperPath();
    if (helperPath) {
      const resolved = await resolveMonitor(targetId);
      if (resolved) {
        const capture: WgcCapture = {
          kind: "wgc",
          monitorIndex: resolved.index + 1,
          showCursor: !hideCursor,
          areaX: area?.x,
          areaY: area?.y,
          areaWidth: area?.width,
          areaHeight: area?.height,
          current: null,
          segments: [],
        };
        const segment = await spawnWgcSegment(helperPath, capture);
        if (segment) {
          // The helper only resolves after its own "Recording started" handshake, so this
          // is the first frame, not merely the spawn.
          clockCapturing();
          capture.current = segment;
          active = capture;
          return true;
        }
        console.warn("[screenCapture] FALLING BACK TO GDIGRAB");
        logNative("WGC helper failed to start capture — falling back to gdigrab");
      }
    }
  }

  if (process.platform === "linux") {
    if (mode === "quick") {
      const helperPath = await resolveLinuxCaptureHelperPath();
      if (helperPath) {
        const outputPath = path.join(os.tmpdir(), `doculigent-screen-${randomUUID()}.mp4`);
        const capture = await startPipeWireCapture(helperPath, outputPath, FPS);
        if (capture) {
          clockCapturing();
          active = capture;
          return true;
        }
        console.warn("[screenCapture] PipeWire helper failed to start capture");
        logNative("PipeWire helper failed to start capture — no native fallback on Linux, using getDisplayMedia");
      }
    }
    // No gdigrab/avfoundation-equivalent fallback exists on Linux — Advanced mode, and
    // Quick mode when the helper is missing/fails, both fall through to the existing
    // getDisplayMedia pipeline via this `false` return (same as before this helper
    // existed at all).
    return false;
  }

  if (process.platform === "darwin") {
    const helperPath = await resolveScreenCaptureKitHelperPath();
    console.log("[screenCapture] native helper resolved", {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      helperPath,
      exists: helperPath ? existsSync(helperPath) : false,
    });
    if (helperPath) {
      const displayId = await resolveMacDisplayId(targetId);
      if (displayId !== null) {
        const outputPath = path.join(os.tmpdir(), `doculigent-screen-${randomUUID()}.mp4`);
        const capture = await startScreenCaptureKitCapture(helperPath, {
          fps: FPS,
          displayId,
          outputPath,
          areaX: area?.x,
          areaY: area?.y,
          areaWidth: area?.width,
          areaHeight: area?.height,
          showsCursor: !hideCursor,
        });
        if (capture) {
          clockCapturing();
          active = capture;
          return true;
        }
        console.warn("[screenCapture] FALLING BACK TO AVFOUNDATION");
        logNative("ScreenCaptureKit helper failed to start capture — falling back to avfoundation");
      }
    }

    const macDeviceIndex = await resolveMacScreenDeviceIndex(targetId);
    if (macDeviceIndex === null) return false;
    const capture: FfmpegCapture = {
      kind: "ffmpeg",
      hideCursor,
      isArea: !!area,
      current: null,
      segments: [],
      macDeviceIndex,
      macArea: area ?? null,
    };
    const segment = await spawnSegment(capture, clockCapturing);
    if (!segment) return false;
    capture.current = segment;
    active = capture;
    return true;
  }

  const displayRect = await resolveDisplayRect(targetId);
  if (!displayRect) return false;

  const winRect = area
    ? {
        x: displayRect.x + Math.round(area.x * displayRect.width),
        y: displayRect.y + Math.round(area.y * displayRect.height),
        width: Math.max(2, Math.round(area.width * displayRect.width)),
        height: Math.max(2, Math.round(area.height * displayRect.height)),
      }
    : displayRect;

  const capture: FfmpegCapture = { kind: "ffmpeg", winRect, hideCursor, isArea: !!area, current: null, segments: [] };
  const segment = await spawnSegment(capture, clockCapturing);
  if (!segment) return false;
  capture.current = segment;
  active = capture;
  return true;
}

export async function pauseScreenCapture(): Promise<boolean> {
  if (!active) return false;
  if (active.kind === "sck" || active.kind === "pipewire") {
    active.proc.stdin?.write("pause\n");
    clockPaused();
    return true;
  }
  if (!active.current) return false;
  const segment = active.current;
  active.current = null;
  // Marked before the flush, not after it: the backend stops grabbing frames as soon as it
  // sees the stop command, while finishSegment/finishWgcSegment go on waiting for the muxer
  // to finalize the file. Counting that flush as recorded time would put everything after
  // the pause out of step by it.
  clockPaused();
  if (active.kind === "wgc") await finishWgcSegment(segment);
  else await finishSegment(segment);
  active.segments.push(segment.outputPath);
  return true;
}

export async function resumeScreenCapture(): Promise<boolean> {
  if (!active) return false;
  if (active.kind === "sck" || active.kind === "pipewire") {
    active.proc.stdin?.write("resume\n");
    clockCapturing();
    return true;
  }
  if (active.current) return false;
  if (active.kind === "wgc") {
    const helperPath = await resolveWindowsCaptureHelperPath();
    if (!helperPath) return false;
    const segment = await spawnWgcSegment(helperPath, active);
    if (!segment) return false;
    clockCapturing();
    active.current = segment;
    return true;
  }
  // ffmpeg anchors itself off its own stderr (see spawnSegment) rather than here -- the new
  // segment isn't capturing yet at the moment its process spawns.
  const segment = await spawnSegment(active, clockCapturing);
  if (!segment) return false;
  active.current = segment;
  return true;
}

export async function stopScreenCapture(): Promise<string | null> {
  if (!active) return null;
  const capture = active;
  active = null;

  if (capture.kind === "sck" || capture.kind === "pipewire") {
    const outputPath = capture.outputPath;
    await new Promise<void>((resolve) => {
      capture.proc.once("close", () => resolve());
      capture.proc.stdin?.write("stop\n");
      capture.proc.stdin?.end();
    });
    return outputPath;
  }

  if (capture.current) {
    if (capture.kind === "wgc") await finishWgcSegment(capture.current);
    else await finishSegment(capture.current);
    capture.segments.push(capture.current.outputPath);
  }

  if (capture.segments.length === 0) return null;
  if (capture.segments.length === 1) return capture.segments[0];
  return concatSegments(capture.segments);
}

export async function discardScreenCapture(): Promise<void> {
  if (!active) return;
  const capture = active;
  active = null;
  clockReset();

  if (capture.kind === "sck" || capture.kind === "pipewire") {
    if (!capture.proc.killed) capture.proc.kill();
    await fs.unlink(capture.outputPath).catch(() => {});
    return;
  }

  if (capture.current && !capture.current.proc.killed) capture.current.proc.kill();
  const paths = capture.current ? [...capture.segments, capture.current.outputPath] : capture.segments;
  for (const p of paths) await fs.unlink(p).catch(() => {});
}

export function killPendingScreenCapture(): void {
  if (!active) return;
  clockReset();
  if (active.kind === "sck" || active.kind === "pipewire") {
    if (!active.proc.killed) active.proc.kill();
  } else if (active.current && !active.current.proc.killed) {
    active.current.proc.kill();
  }
  active = null;
}
