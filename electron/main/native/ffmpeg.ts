
import { spawn, type ChildProcess } from "node:child_process";
import ffmpegStaticPath from "ffmpeg-static";
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

export function convertToWav(inputWebmPath: string, outputWavPath: string): Promise<void> {
  return run(["-y", "-i", inputWebmPath, "-c:a", "pcm_s16le", outputWavPath]);
}

/** Screen-only gdigrab output (see native/screenCapture.ts), no camera/mic side clip to
 *  combine — just a fast container copy into the library's mp4, no re-encode needed since
 *  gdigrab already wrote h264. */
export function copyToMp4(
  inputPath: string,
  outputMp4Path: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  return run(["-y", "-i", inputPath, "-c", "copy", outputMp4Path], onProgress, signal);
}

/** gdigrab screen video + a mic-only audio clip (camera off, mic on). The screen stream is
 *  copied as-is (already h264 from gdigrab); only the audio gets encoded. */
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

/** gdigrab screen video + a camera-bubble clip (camera on), overlaid at a fixed pixel
 *  position — see shared/lib/cameraBubble.ts for how x/y/size are derived, kept identical
 *  to the canvas-compositor path used when gdigrab isn't available. `bubbleHasAudio`
 *  selects whether the bubble clip's own audio (recorded together with it) is mapped in;
 *  when false the output is silent (mic was muted for this recording).
 *
 * `circular` re-derives the bubble's circular mask from pure pixel geometry at combine
 * time rather than trusting alpha in the bubble clip itself: Chromium's
 * canvas.captureStream() → MediaRecorder pipeline does NOT preserve the canvas's alpha
 * channel (verified empirically — the encoded stream comes back plain yuv420p, no alpha
 * plane), so the circular clip already baked into the bubble canvas collapses to opaque
 * black outside the circle once encoded. Without this mask that black square would show
 * up as a visible corner artifact around every circular bubble; the geq filter punches an
 * alpha hole through it using the same circle math the canvas used, so the screen video
 * shows through underneath exactly where it should. */
export function overlayCameraBubble(
  screenPath: string,
  bubblePath: string,
  bubble: { x: number; y: number },
  circular: boolean,
  bubbleHasAudio: boolean,
  outputMp4Path: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  const circleMask =
    "if(lte(pow(X-(W/2)\\,2)+pow(Y-(H/2)\\,2)\\,pow(W/2\\,2))\\,255\\,0)";
  const bubbleFilter = circular
    ? `[1:v]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${circleMask}'[bubble]`
    : `[1:v]format=rgba[bubble]`;
  const args = [
    "-y",
    "-i",
    screenPath,
    "-i",
    bubblePath,
    "-filter_complex",
    `${bubbleFilter};[0:v][bubble]overlay=x=${bubble.x}:y=${bubble.y}:format=auto[v]`,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
  ];
  if (bubbleHasAudio) {
    args.push("-map", "1:a", "-c:a", "aac", "-shortest");
  }
  args.push(outputMp4Path);
  return run(args, onProgress, signal);
}
