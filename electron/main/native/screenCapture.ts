import { desktopCapturer, screen } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import ffmpegStaticPath from "ffmpeg-static";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";
import type { AreaRect } from "@shared/types/models";
import { listPhysicalMonitors, type PhysicalMonitor } from "./monitors";

const ffmpegPath = (ffmpegStaticPath ?? "ffmpeg").replace("app.asar", "app.asar.unpacked");

const FPS = 30;

interface Segment {
  proc: ChildProcess;
  outputPath: string;
}

interface ActiveCapture {
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

function winArgs(capture: ActiveCapture, outputPath: string): string[] {
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

function macArgs(capture: ActiveCapture, outputPath: string): string[] {
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
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    outputPath,
  ];
}

function spawnSegment(capture: ActiveCapture): Promise<Segment | null> {
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

export async function startScreenCapture(targetId: string, hideCursor: boolean, area?: AreaRect): Promise<boolean> {
  if (active || !canCaptureTarget(targetId)) return false;

  if (process.platform === "darwin") {
    const macDeviceIndex = await resolveMacScreenDeviceIndex(targetId);
    if (macDeviceIndex === null) return false;
    const capture: ActiveCapture = {
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

  const capture: ActiveCapture = { winRect, hideCursor, isArea: !!area, current: null, segments: [] };
  const segment = await spawnSegment(capture);
  if (!segment) return false;
  capture.current = segment;
  active = capture;
  return true;
}

export async function pauseScreenCapture(): Promise<boolean> {
  if (!active || !active.current) return false;
  const segment = active.current;
  active.current = null;
  await finishSegment(segment);
  active.segments.push(segment.outputPath);
  return true;
}

export async function resumeScreenCapture(): Promise<boolean> {
  if (!active || active.current) return false;
  const segment = await spawnSegment(active);
  if (!segment) return false;
  active.current = segment;
  return true;
}

export async function stopScreenCapture(): Promise<string | null> {
  if (!active) return null;
  const capture = active;
  active = null;

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

  if (capture.current && !capture.current.proc.killed) capture.current.proc.kill();
  const paths = capture.current ? [...capture.segments, capture.current.outputPath] : capture.segments;
  for (const p of paths) await fs.unlink(p).catch(() => {});
}

export function killPendingScreenCapture(): void {
  if (active?.current && !active.current.proc.killed) active.current.proc.kill();
  active = null;
}
