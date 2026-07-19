/**
 * ffmpeg is used for two jobs, neither of which is the core recording engine (see
 * FUNCTIONALITY.md §7.6/7.7 for why: canvas + MediaRecorder in the renderer handles
 * compositing + real-time-correct encoding on its own):
 *  - remuxing the Record tab's MediaRecorder WebM output into MP4 for universal
 *    playback/sharing compatibility.
 *  - converting the Meeting tab's WebM/Opus audio into WAV (uncompressed PCM) — note
 *    this makes meeting recordings much larger on disk than the original compressed
 *    Opus (roughly 10x for a typical voice recording), a deliberate trade-off for WAV's
 *    universal compatibility with audio tools.
 */
import { spawn, type ChildProcess } from "node:child_process";
import ffmpegStaticPath from "ffmpeg-static";

// ffmpeg-static's binary can't be executed straight out of an asar archive in a packaged
// build; electron-builder's `asarUnpack` (see electron-builder.yml) extracts it next to
// the archive as "app.asar.unpacked" — this rewrites the path to match.
const ffmpegPath = (ffmpegStaticPath ?? "ffmpeg").replace("app.asar", "app.asar.unpacked");

// The MP4 transcode now runs in the background after Stop returns (see recording.ts),
// so unlike before, a quit can genuinely race an in-flight ffmpeg process. Node doesn't
// kill child processes automatically when the parent exits, and there's no point
// leaving one running anyway — whatever it produces would never get inserted into the
// library, since that happens back in the (now-exited) main process. Tracked here so
// killPendingFfmpegJobs() (called on app quit) can clean them up.
const activeProcesses = new Set<ChildProcess>();

export function killPendingFfmpegJobs(): void {
  for (const proc of activeProcesses) proc.kill();
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    activeProcesses.add(proc);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      activeProcesses.delete(proc);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export function remuxToMp4(inputWebmPath: string, outputMp4Path: string): Promise<void> {
  return run([
    "-y",
    "-i",
    inputWebmPath,
    "-c:v",
    "libx264",
    // This now runs in the background after Stop returns (see recording.ts), so it no
    // longer needs to race a blocked UI — "medium" (libx264's own default) trades a
    // slower encode for meaningfully smaller output than "veryfast" at the same quality.
    "-preset",
    "medium",
    "-c:a",
    "aac",
    outputMp4Path,
  ]);
}

export function convertToWav(inputWebmPath: string, outputWavPath: string): Promise<void> {
  return run(["-y", "-i", inputWebmPath, "-c:a", "pcm_s16le", outputWavPath]);
}
