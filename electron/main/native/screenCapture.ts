/**
 * Records a chosen display straight to an mp4 via ffmpeg's gdigrab, bypassing Chromium's
 * desktopCapturer entirely for the final output. This exists for one reason: Chromium
 * always bakes the real cursor into desktop-capture frames — the `cursor: "never"`
 * MediaTrackConstraint is accepted but silently ignored (verified empirically: parking the
 * cursor and diffing frames captured with and without the constraint showed no difference).
 * gdigrab's `-draw_mouse 0`, by contrast, genuinely excludes it while leaving the real
 * pointer completely untouched on screen — nothing here ever hides or replaces it (compare
 * native/systemCursor.ts, which does swap the real cursor, for the other highlight styles).
 *
 * Scope: whole-display captures on Windows only.
 *  - Windows-only because gdigrab is a Windows-specific ffmpeg input; other platforms keep
 *    using the ordinary getUserMedia/MediaRecorder pipeline (cursor baked in, unchanged).
 *  - Display-only because gdigrab has no robust way to target a specific window the way
 *    Chromium's chromeMediaSourceId does (it can only match by window title, which isn't
 *    unique and isn't stable) — window captures also fall back to the ordinary pipeline.
 *
 * The output is scaled/padded to CANVAS_WIDTH x CANVAS_HEIGHT (see compositor.ts) so
 * everything downstream — the Video model, Edit, thumbnailing — keeps assuming the same
 * fixed 1920x1080 frame it always has, regardless of the recorded display's native
 * resolution.
 */
import { desktopCapturer, screen } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import ffmpegStaticPath from "ffmpeg-static";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";
import { listPhysicalMonitors, type PhysicalMonitor } from "./monitors";

const ffmpegPath = (ffmpegStaticPath ?? "ffmpeg").replace("app.asar", "app.asar.unpacked");

const FPS = 30;

interface ActiveCapture {
  proc: ChildProcess;
  outputPath: string;
}

let active: ActiveCapture | null = null;

/** Matches an Electron Display to its true physical-pixel monitor rect by size (DIP size *
 *  scaleFactor should equal the physical size regardless of position, even when DPI
 *  virtualization scrambles positions — see native/monitors.ts) with primary-ness as a
 *  tiebreaker for same-sized monitors. Returns null rather than guess when nothing lines
 *  up, so callers can cleanly fall back to the ordinary capture pipeline instead of
 *  recording the wrong region. */
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

/** True only for the case this module actually handles — everything else (window targets,
 *  non-Windows) should keep using the existing getUserMedia pipeline. */
export function canCaptureTarget(targetId: string): boolean {
  return process.platform === "win32" && targetId.startsWith("screen:");
}

/** Starts recording `targetId` to a fresh temp file. Resolves `null` (not a rejection)
 *  whenever this path doesn't apply or the target display couldn't be resolved — the
 *  caller's job is to fall back cleanly, not to surface an error for an expected case. */
export async function startScreenCapture(targetId: string, hideCursor: boolean): Promise<boolean> {
  if (active || !canCaptureTarget(targetId)) return false;

  const rect = await resolveDisplayRect(targetId);
  if (!rect) return false;

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
    // Fits the captured display into the fixed output frame the rest of the app assumes,
    // the same centered-on-black behavior as compositor.ts's drawLetterboxed.
    "-vf",
    `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,` +
      `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    outputPath,
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
  active = { proc, outputPath };

  return new Promise((resolve) => {
    proc.once("spawn", () => resolve(true));
    proc.once("error", () => {
      active = null;
      resolve(false);
    });
  });
}

/** Stops the running capture and returns its file path, or null if nothing was running.
 *  Stops gdigrab the graceful way (a 'q' on stdin, same as an interactive ffmpeg session)
 *  so the mp4's trailer gets written properly — killing the process outright can leave the
 *  file without a readable duration/index. Falls back to a hard kill if ffmpeg doesn't
 *  exit promptly, so a stuck process can never block "stop recording" indefinitely. */
export async function stopScreenCapture(): Promise<string | null> {
  if (!active) return null;
  const { proc, outputPath } = active;
  active = null;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    proc.once("close", finish);
    const timer = setTimeout(() => {
      if (!proc.killed) proc.kill();
      finish();
    }, 5000);
    proc.stdin?.write("q");
    proc.stdin?.end();
  });

  return outputPath;
}

export function killPendingScreenCapture(): void {
  if (active) active.proc.kill();
  active = null;
}
