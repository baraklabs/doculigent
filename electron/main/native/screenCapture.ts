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
  rect: { x: number; y: number; width: number; height: number };
  hideCursor: boolean;
  isArea: boolean;
  current: Segment | null;
  segments: string[];
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

export function canCaptureTarget(targetId: string): boolean {
  return process.platform === "win32" && targetId.startsWith("screen:");
}

function vfFor(isArea: boolean): string {
  return isArea
    ? "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p"
    : `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
        `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`;
}

function spawnSegment(capture: ActiveCapture): Promise<Segment | null> {
  const { rect, hideCursor, isArea } = capture;
  const outputPath = path.join(os.tmpdir(), `doculigent-screen-${randomUUID()}.mp4`);
  const args = [
    "-y",
    "-f",
    "gdigrab",
    "-draw_mouse",
    hideCursor ? "0" : "1",
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
    vfFor(isArea),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    outputPath,
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });

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

  const displayRect = await resolveDisplayRect(targetId);
  if (!displayRect) return false;

  const rect = area
    ? {
        x: displayRect.x + Math.round(area.x * displayRect.width),
        y: displayRect.y + Math.round(area.y * displayRect.height),
        width: Math.max(2, Math.round(area.width * displayRect.width)),
        height: Math.max(2, Math.round(area.height * displayRect.height)),
      }
    : displayRect;

  const capture: ActiveCapture = { rect, hideCursor, isArea: !!area, current: null, segments: [] };
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
