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

type ActiveCapture = FfmpegCapture | SckCapture;

let active: ActiveCapture | null = null;

function matchPhysicalRect(display: Electron.Display, monitors: PhysicalMonitor[]): PhysicalMonitor["rect"] | null {
  const expectedW = Math.round(display.bounds.width * display.scaleFactor);
  const expectedH = Math.round(display.bounds.height * display.scaleFactor);
  const isPrimaryDisplay = display.id === screen.getPrimaryDisplay().id;

  const candidates = monitors.filter(
    (m) => Math.abs(m.rect.width - expectedW) <= 2 && Math.abs(m.rect.height - expectedH) <= 2
  );
  if (candidates.length === 1) return candidates[0].rect;
  if (candidates.length > 1) {
    return (candidates.find((m) => m.primary === isPrimaryDisplay) ?? candidates[0]).rect;
  }
  return isPrimaryDisplay ? (monitors.find((m) => m.primary)?.rect ?? null) : null;
}

async function resolveDisplayRect(targetId: string): Promise<PhysicalMonitor["rect"] | null> {
  const sources = await desktopCapturer.getSources({ types: ["screen"] });
  const source = sources.find((s) => s.id === targetId);
  if (!source) return null;
  const display =
    screen.getAllDisplays().find((d) => String(d.id) === source.display_id) ?? screen.getPrimaryDisplay();

  const monitors = listPhysicalMonitors();
  if (monitors.length === 0) return null;
  return matchPhysicalRect(display, monitors);
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

export function canCaptureTarget(targetId: string): boolean {
  // Only whole-display targets — neither gdigrab nor avfoundation can capture a single
  // window the way desktopCapturer's window sources can, so "window:..." targets always
  // fall back to the getDisplayMedia-based pipeline on both platforms.
  return (process.platform === "win32" || process.platform === "darwin") && targetId.startsWith("screen:");
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

function spawnSegment(capture: FfmpegCapture): Promise<Segment | null> {
  const outputPath = path.join(os.tmpdir(), `doculigent-screen-${randomUUID()}.mp4`);
  const args = process.platform === "darwin" ? macArgs(capture, outputPath) : winArgs(capture, outputPath);

  const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  proc.once("close", (code) => {
    if (code !== 0 && code !== null) console.error(`[screenCapture] ffmpeg segment exited ${code}:`, stderr.slice(-1000));
  });

  return new Promise((resolve) => {
    proc.once("spawn", () => resolve({ proc, outputPath }));
    proc.once("error", () => resolve(null));
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

export async function startScreenCapture(targetId: string, hideCursor: boolean, area?: AreaRect): Promise<boolean> {
  if (active || !canCaptureTarget(targetId)) return false;

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
        });
        if (capture) {
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
    const segment = await spawnSegment(capture);
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
  const segment = await spawnSegment(capture);
  if (!segment) return false;
  capture.current = segment;
  active = capture;
  return true;
}

export async function pauseScreenCapture(): Promise<boolean> {
  if (!active) return false;
  if (active.kind === "sck") {
    active.proc.stdin?.write("pause\n");
    return true;
  }
  if (!active.current) return false;
  const segment = active.current;
  active.current = null;
  await finishSegment(segment);
  active.segments.push(segment.outputPath);
  return true;
}

export async function resumeScreenCapture(): Promise<boolean> {
  if (!active) return false;
  if (active.kind === "sck") {
    active.proc.stdin?.write("resume\n");
    return true;
  }
  if (active.current) return false;
  const segment = await spawnSegment(active);
  if (!segment) return false;
  active.current = segment;
  return true;
}

export async function stopScreenCapture(): Promise<string | null> {
  if (!active) return null;
  const capture = active;
  active = null;

  if (capture.kind === "sck") {
    const outputPath = capture.outputPath;
    await new Promise<void>((resolve) => {
      capture.proc.once("close", () => resolve());
      capture.proc.stdin?.write("stop\n");
      capture.proc.stdin?.end();
    });
    return outputPath;
  }

  if (capture.current) {
    await finishSegment(capture.current);
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

  if (capture.kind === "sck") {
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
  if (active.kind === "sck") {
    if (!active.proc.killed) active.proc.kill();
  } else if (active.current && !active.current.proc.killed) {
    active.current.proc.kill();
  }
  active = null;
}
