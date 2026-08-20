
import { spawn, type ChildProcess } from "node:child_process";
import ffmpegStaticPath from "ffmpeg-static";
import type { CameraBubbleShape } from "@shared/types/models";
const ffmpegPath = (ffmpegStaticPath ?? "ffmpeg").replace("app.asar", "app.asar.unpacked");
const activeProcesses = new Set<ChildProcess>();

export function killPendingFfmpegJobs(): void {
  for (const proc of activeProcesses) proc.kill();
}

type ProgressHandler = (secondsDone: number) => void;

export class FfmpegCancelledError extends Error {
  constructor() {
    super("ffmpeg job cancelled");
    this.name = "FfmpegCancelledError";
  }
}

function run(args: string[], onProgress?: ProgressHandler, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, onProgress ? ["-progress", "pipe:1", "-nostats", ...args] : args);
    activeProcesses.add(proc);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (onProgress) {
      let pending = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const [key, value] = line.trim().split("=");
          if (key === "out_time_us" && value && value !== "N/A") {
            const seconds = Number(value) / 1_000_000;
            if (Number.isFinite(seconds)) onProgress(seconds);
          }
        }
      });
    }
    const onAbort = () => proc.kill();
    if (signal) {
      if (signal.aborted) proc.kill();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("error", reject);
    proc.on("close", (code) => {
      activeProcesses.delete(proc);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new FfmpegCancelledError());
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export function remuxToMp4(
  inputWebmPath: string,
  outputMp4Path: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  return run(
    ["-y", "-i", inputWebmPath, "-c:v", "libx264", "-preset", "medium", "-c:a", "aac", outputMp4Path],
    onProgress,
    signal
  );
}

/** Turns a raw, uncropped/unscaled screen recording (the non-native fallback's own
 *  MediaRecorder output — see native/screenCapture.ts's `vfFor` for what a native gdigrab
 *  capture already bakes in at capture time) into the same shape `metadata/screen.mp4`
 *  has for a native recording, so everything downstream (camera-bubble overlay, cursor
 *  overlay, Edit-page playback) can treat the two identically. No audio — this stream was
 *  always requested video-only (see desktopConstraints), same as gdigrab. */
export function transcodeScreenRecording(
  inputWebmPath: string,
  outputMp4Path: string,
  vf: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  return run(
    ["-y", "-i", inputWebmPath, "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", "-an", outputMp4Path],
    onProgress,
    signal
  );
}

export function transcodeExport(
  inputWebmPath: string,
  outputMp4Path: string,
  width: number,
  height: number,
  fps: number,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  return run(
    [
      "-y",
      "-i",
      inputWebmPath,
      "-vf",
      `scale=${width}:${height}:flags=lanczos,fps=${fps}`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputMp4Path,
    ],
    onProgress,
    signal
  );
}

export function convertToWav(
  inputWebmPath: string,
  outputWavPath: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  return run(["-y", "-i", inputWebmPath, "-c:a", "pcm_s16le", outputWavPath], onProgress, signal);
}

export function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ["-i", filePath]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", () => resolve(0));
    proc.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) {
        resolve(0);
        return;
      }
      const [, hours, minutes, seconds] = match;
      resolve(Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds));
    });
  });
}

export function copyToMp4(
  inputPath: string,
  outputMp4Path: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  return run(["-y", "-i", inputPath, "-c", "copy", outputMp4Path], onProgress, signal);
}

// Whether this bundled ffmpeg binary has h264_videotoolbox at all — probed once (an
// `-encoders` listing is near-instant, no file I/O) and cached, instead of discovering it
// by attempting a full real-time hardware encode and catching the failure. That "try it
// and catch" approach used to sit here, but if the encoder is *listed* yet errors out only
// partway through a long file (rather than failing instantly), it pays for a wasted
// partial hardware attempt AND the full software fallback — measured worse than software
// alone, not better. A cheap up-front probe avoids that stacked-failure case entirely for
// the common "not compiled in" reason; a runtime failure after the probe passes still
// falls back below, just no longer the expected path.
let videotoolboxAvailable: Promise<boolean> | null = null;
function hasVideotoolboxEncoder(): Promise<boolean> {
  if (!videotoolboxAvailable) {
    videotoolboxAvailable = new Promise((resolve) => {
      const proc = spawn(ffmpegPath, ["-hide_banner", "-encoders"]);
      let out = "";
      proc.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
      });
      proc.on("error", () => resolve(false));
      proc.on("close", () => resolve(out.includes("h264_videotoolbox")));
    });
  }
  return videotoolboxAvailable;
}

/** macOS-only normalization pass — native/screenCapture.ts's avfoundation capture uses
 *  -fps_mode vfr at capture time to avoid a runaway frame-duplication bug (real-time
 *  encoding pressure against avfoundation's irregular, damage-driven frame delivery), but
 *  everything downstream (overlayCameraBubble, overlayCursorTrack) assumes a predictable
 *  CFR stream — overlayCursorTrack in particular precomputes its overlay frame count as
 *  durationSecs * 30 and pipes exactly that many raw frames into ffmpeg's stdin, which
 *  faults with EPIPE the moment the primary (VFR, frame-count-mismatched) video input
 *  runs out of frames first (confirmed). This is a cheap, non-realtime, bounded-by-file-
 *  length pass — unlike the live capture, there's no risk of the same runaway
 *  duplication here, since it's just re-encoding an already-finished file.
 *
 *  This is the one re-encode pass Advanced Recording can't skip on mac (Quick doesn't run
 *  it at all — see resolveScreenTrack's needsCfr), so it's worth paying for hardware
 *  encoding when it's actually there: VideoToolbox runs on the Mac's media engine instead
 *  of the CPU, cutting a ~1-minute software libx264 -preset ultrafast pass (for a
 *  10-minute recording) down dramatically. Falls back to the software encoder if
 *  VideoToolbox isn't available (see hasVideotoolboxEncoder) or errors at runtime, rather
 *  than failing the whole save either way. */
export async function normalizeToCfr(
  inputPath: string,
  outputMp4Path: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  const started = Date.now();
  if (await hasVideotoolboxEncoder()) {
    try {
      await run(
        [
          "-y", "-i", inputPath, "-vf", "fps=30",
          "-c:v", "h264_videotoolbox", "-b:v", "20M", "-pix_fmt", "yuv420p",
          "-an", outputMp4Path,
        ],
        onProgress,
        signal
      );
      console.log(`[ffmpeg] normalizeToCfr (videotoolbox) took ${Date.now() - started}ms`);
      return;
    } catch (e) {
      if (e instanceof FfmpegCancelledError || (signal?.aborted ?? false)) throw e;
      console.warn("[ffmpeg] h264_videotoolbox normalizeToCfr failed at runtime, falling back to libx264", e);
    }
  }
  await run(
    ["-y", "-i", inputPath, "-vf", "fps=30", "-c:v", "libx264", "-preset", "ultrafast", "-an", outputMp4Path],
    onProgress,
    signal
  );
  console.log(`[ffmpeg] normalizeToCfr (libx264 fallback) took ${Date.now() - started}ms`);
}

export function muxScreenWithAudio(
  screenPath: string,
  audioPath: string,
  outputMp4Path: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  return run(
    [
      "-y",
      "-i",
      screenPath,
      "-i",
      audioPath,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      outputMp4Path,
    ],
    onProgress,
    signal
  );
}

export interface CameraBubbleTrackPoint {
  atSec: number;
  x: number;
  y: number;
}

export interface CameraBubbleTrack {
  width: number;
  height: number;
  points: CameraBubbleTrackPoint[];
}

function stepExpr(points: CameraBubbleTrackPoint[], pick: (p: CameraBubbleTrackPoint) => number): string {
  let expr = String(pick(points[points.length - 1]));
  for (let i = points.length - 2; i >= 0; i--) {
    expr = `if(lt(t\\,${points[i + 1].atSec})\\,${pick(points[i])}\\,${expr})`;
  }
  return expr;
}

export function overlayCameraBubble(
  screenPath: string,
  bubblePath: string,
  bubble: CameraBubbleTrack,
  shape: CameraBubbleShape,
  mirror: boolean,
  bubbleHasAudio: boolean,
  outputMp4Path: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  const aspect = bubble.width / bubble.height;
  const cropExpr = `crop=w='if(gt(iw/ih\\,${aspect})\\,ih*${aspect}\\,iw)':h='if(gt(iw/ih\\,${aspect})\\,ih\\,iw/${aspect})'`;
  const mirrorExpr = mirror ? "hflip," : "";
  const scaleExpr = `scale=${bubble.width}:${bubble.height}`;

  const circleMask = "if(lte(pow(X-(W/2)\\,2)+pow(Y-(H/2)\\,2)\\,pow(W/2\\,2))\\,255\\,0)";
  const cropScale = `${mirrorExpr}${cropExpr},${scaleExpr}`;
  const bubbleFilter =
    shape === "round"
      ? `[1:v]${cropScale},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${circleMask}'[bubble]`
      : `[1:v]${cropScale},format=rgba[bubble]`;
  const xExpr = stepExpr(bubble.points, (p) => p.x);
  const yExpr = stepExpr(bubble.points, (p) => p.y);
  const args = [
    "-y",
    "-i",
    screenPath,
    "-i",
    bubblePath,
    "-filter_complex",
    `${bubbleFilter};[0:v][bubble]overlay=x='${xExpr}':y='${yExpr}':eval=frame:format=auto[v]`,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
  ];
  if (bubbleHasAudio) {
    args.push("-map", "1:a", "-c:a", "aac", "-shortest");
  }
  args.push(outputMp4Path);
  return run(args, onProgress, signal);
}
