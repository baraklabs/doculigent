
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import type { CameraBubbleShape } from "@shared/types/models";
import { logNative } from "./nativeLog";
import { encoderCacheFilePath } from "./paths";
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

export interface ImagePipeExportHandle {
  /** Writes one JPEG-encoded frame, in output order. Resolves once ffmpeg's stdin has
   *  actually accepted it (waiting on its own internal 'drain' if the pipe is momentarily
   *  full) — awaiting this in sequence is what gives the renderer's frame-producing loop
   *  backpressure against ffmpeg's real encode throughput, rather than racing ahead of it. */
  writeFrame(jpeg: Buffer): Promise<void>;
  /** Closes stdin (signaling "no more frames") and resolves once ffmpeg has finished
   *  encoding everything already written and exited cleanly — rejects with
   *  FfmpegCancelledError if the process was aborted via `signal` first. */
  finish(): Promise<void>;
}

export type H264Encoder = "h264_videotoolbox" | "h264_nvenc" | "h264_qsv" | "h264_amf" | "h264_mf" | "libx264";

interface EncoderCacheEntry {
  platform: string;
  arch: string;
  ffmpegVersion: string;
  encoder: H264Encoder;
}

function candidateEncoders(): H264Encoder[] {
  if (process.platform === "darwin") return ["h264_videotoolbox", "libx264"];
  // h264_mf (Media Foundation) sits after the three dedicated-GPU encoders — it can still
  // hand off to a hardware MFT itself when the OS has one, but it's the least specific of
  // the four (no vendor-specific rate-control knobs), so it's only reached when
  // nvenc/qsv/amf all fail their probe.
  if (process.platform === "win32") return ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libx264"];
  return ["libx264"];
}

let cachedFfmpegVersion: string | null = null;
function ffmpegVersionString(): Promise<string> {
  if (cachedFfmpegVersion) return Promise.resolve(cachedFfmpegVersion);
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ["-version"]);
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("error", () => resolve("unknown"));
    proc.on("close", () => {
      cachedFfmpegVersion = out.match(/ffmpeg version (\S+)/)?.[1] ?? "unknown";
      resolve(cachedFfmpegVersion);
    });
  });
}

function readEncoderCache(): EncoderCacheEntry | null {
  try {
    return JSON.parse(fs.readFileSync(encoderCacheFilePath(), "utf-8")) as EncoderCacheEntry;
  } catch {
    return null;
  }
}

function writeEncoderCache(entry: EncoderCacheEntry): void {
  try {
    fs.mkdirSync(path.dirname(encoderCacheFilePath()), { recursive: true });
    fs.writeFileSync(encoderCacheFilePath(), JSON.stringify(entry));
  } catch {
    // Cache is a pure optimization — losing it just means re-probing next launch.
  }
}

/** A real 1-frame encode, not just membership in `ffmpeg -encoders` — that list only means
 *  the encoder was compiled in, not that this machine actually has the driver/GPU it needs.
 *  NVENC/QSV/AMF all fail at encode time, not at listing time, when the hardware isn't
 *  there. libx264 is never probed — it's always compiled into ffmpeg-static and every other
 *  ffmpeg call in this file already trusts that unconditionally.
 *
 *  320x240, not a smaller frame — verified directly against this machine's real hardware
 *  (an actual NVENC-capable GPU present): a 64x64 test frame makes h264_nvenc fail to
 *  initialize with "Frame Dimension less than the minimum supported value" (confirmed exit
 *  code, not a guess), which would have reported working NVENC hardware as unusable and
 *  silently fallen back to a worse encoder (or software libx264) forever, since the result
 *  gets cached to disk. 320x240 encodes in the same ~50ms either way, so there's no real
 *  cost to using a size that's actually safe across encoders. */
function probeEncoderUsable(encoder: H264Encoder): Promise<boolean> {
  if (encoder === "libx264") return Promise.resolve(true);
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, [
      "-f", "lavfi", "-i", "color=c=black:s=320x240:r=1",
      "-frames:v", "1",
      "-pix_fmt", "yuv420p",
      "-c:v", encoder,
      "-f", "null", "-",
    ]);
    let settled = false;
    const finishProbe = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => {
      proc.kill();
      finishProbe(false);
    }, 5000);
    proc.on("error", () => {
      clearTimeout(timer);
      finishProbe(false);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      finishProbe(code === 0);
    });
  });
}

let detectPromise: Promise<H264Encoder> | null = null;

/** Resolves once per process lifetime (memoized) and persisted to encoder-cache.json across
 *  restarts — probing every hardware encoder candidate is a multi-second cost (each spawns
 *  a real ffmpeg process), which only needs to happen once per {platform, arch, ffmpeg
 *  version}, not once per export. */
export function detectH264Encoder(): Promise<H264Encoder> {
  if (!detectPromise) {
    detectPromise = (async () => {
      const platform = process.platform;
      const arch = process.arch;
      const ffmpegVersion = await ffmpegVersionString();

      const cached = readEncoderCache();
      if (cached && cached.platform === platform && cached.arch === arch && cached.ffmpegVersion === ffmpegVersion) {
        logNative(`[ffmpeg] using cached H.264 encoder: ${cached.encoder}`);
        return cached.encoder;
      }

      for (const candidate of candidateEncoders()) {
        const usable = candidate === "libx264" ? true : await probeEncoderUsable(candidate);
        logNative(`[ffmpeg] encoder probe: ${candidate} -> ${usable ? "usable" : "unusable"}`);
        if (usable) {
          writeEncoderCache({ platform, arch, ffmpegVersion, encoder: candidate });
          logNative(`[ffmpeg] selected H.264 encoder: ${candidate}`);
          return candidate;
        }
      }
      return "libx264"; // unreachable — libx264 always resolves usable — keeps the return type honest
    })();
  }
  return detectPromise;
}

/** Forces every future call to detectH264Encoder (this run, and — via the persisted cache
 *  — future launches) straight to libx264, without re-probing the other hardware
 *  candidates. Used when a hardware encoder passes its startup probe but then fails for
 *  real once an export actually spawns it (see spawnWithFallback) — rare enough that going
 *  straight to the always-safe software path is the right call, rather than spending
 *  several more seconds probing alternatives that likely share the same root cause (e.g.
 *  no dGPU at all). */
function blacklistCurrentEncoder(): void {
  detectPromise = Promise.resolve("libx264");
  writeEncoderCache({
    platform: process.platform,
    arch: process.arch,
    ffmpegVersion: cachedFfmpegVersion ?? "unknown",
    encoder: "libx264",
  });
}

/** ~0.08 bits/pixel/frame — a high-quality target sized for screen/text content, well
 *  above typical camera-content encoding factors (~0.05), since sharp UI edges need more
 *  bits than natural video to stay clean without blocking. Used for every hardware
 *  encoder's rate control: unlike a vendor-specific constant-quality mode (NVENC's `-cq`,
 *  QSV's `-global_quality`, AMF's CQP `-qp_i`/`-qp_p`), `-b:v`/`-maxrate`/`-bufsize` are
 *  guaranteed-valid syntax across h264_nvenc/h264_qsv/h264_amf/h264_videotoolbox alike —
 *  the safer choice for a first pass we can't verify on every vendor's hardware. */
function estimateBitrateKbps(width: number, height: number, fps: number): number {
  const bitsPerPixelPerFrame = 0.08;
  return Math.max(1500, Math.round((width * height * fps * bitsPerPixelPerFrame) / 1000));
}

function videoEncoderArgs(encoder: H264Encoder, width: number, height: number, fps: number): string[] {
  if (encoder === "libx264") {
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p"];
  }
  const bitrateKbps = estimateBitrateKbps(width, height, fps);
  const rateControl = ["-b:v", `${bitrateKbps}k`, "-maxrate", `${Math.round(bitrateKbps * 1.5)}k`, "-bufsize", `${bitrateKbps * 2}k`];
  const common = ["-profile:v", "high", "-pix_fmt", "yuv420p", ...rateControl];
  switch (encoder) {
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-allow_sw", "0", ...common];
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p6", "-rc", "vbr", ...common];
    case "h264_qsv": {
      // QSV's hardware surface is NV12, not planar yuv420p (confirmed directly: feeding it
      // the shared `common` pix_fmt makes ffmpeg log "Incompatible pixel format 'yuv420p'
      // ... auto-selecting nv12" and convert anyway — same end result, but spelling it out
      // avoids the implicit conversion and the log noise on every single job).
      const qsvArgs = common.map((arg) => (arg === "yuv420p" ? "nv12" : arg));
      return ["-c:v", "h264_qsv", "-preset", "veryslow", ...qsvArgs];
    }
    case "h264_amf":
      return ["-c:v", "h264_amf", "-quality", "quality", ...common];
    case "h264_mf":
      // Media Foundation's ffmpeg wrapper has no vendor-specific constant-quality mode of
      // its own (no `-cq`/`-global_quality`/CQP equivalent) — the shared -b:v/-maxrate/
      // -bufsize rate control is all it takes.
      return ["-c:v", "h264_mf", ...common];
    default:
      return ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p"];
  }
}

function buildExportArgs(
  encoder: H264Encoder,
  audioWavPath: string | null,
  width: number,
  height: number,
  fps: number,
  outputMp4Path: string
): string[] {
  const args = ["-progress", "pipe:1", "-nostats", "-y", "-f", "image2pipe", "-vcodec", "mjpeg", "-r", String(fps), "-i", "pipe:0"];
  if (audioWavPath) args.push("-i", audioWavPath);
  args.push("-map", "0:v");
  if (audioWavPath) args.push("-map", "1:a");
  args.push("-vf", `scale=${width}:${height}:flags=lanczos`, "-r", String(fps), ...videoEncoderArgs(encoder, width, height, fps));
  if (audioWavPath) args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  else args.push("-an");
  args.push("-movflags", "+faststart", outputMp4Path);
  return args;
}

interface SpawnedEncode {
  proc: ChildProcessWithoutNullStreams;
  stderrTailRef: { current: string };
  exited: Promise<{ code: number | null }>;
}

// Same three-stream layout as every other job in this file (run()) — stdin carries the
// frame data in, stdout carries `-progress`'s key=value lines, stderr carries ffmpeg's
// normal diagnostic text — just spawned directly here instead of through run(), since
// this one needs a live handle to keep writing to stdin over time.
function spawnFfmpegProcess(args: string[]): SpawnedEncode {
  const proc = spawn(ffmpegPath, args);
  activeProcesses.add(proc);
  const stderrTailRef = { current: "" };
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrTailRef.current = (stderrTailRef.current + chunk.toString()).slice(-4000);
  });
  const exited = new Promise<{ code: number | null }>((resolve) => {
    proc.on("error", () => resolve({ code: -1 }));
    proc.on("close", (code) => {
      activeProcesses.delete(proc);
      resolve({ code });
    });
  });
  return { proc, stderrTailRef, exited };
}

const HARDWARE_ENCODER_GRACE_MS = 600;

/** Spawns the export with `encoder`; if it's a hardware encoder and the process dies within
 *  a short grace window (hardware encoder init failures — no driver, no GPU — surface
 *  within tens of milliseconds, well before any real frame work happens), blacklists it and
 *  re-spawns with libx264 instead. A software encoder is never grace-checked — it doesn't
 *  fail this way, and the check would just be a flat delay on every single export. */
async function spawnWithFallback(
  encoder: H264Encoder,
  args: string[],
  fallbackArgsBuilder: () => string[]
): Promise<{ spawned: SpawnedEncode; encoderUsed: H264Encoder }> {
  let spawned = spawnFfmpegProcess(args);
  let encoderUsed = encoder;
  if (encoder !== "libx264") {
    const graceResult = await Promise.race([
      spawned.exited.then((r) => ({ diedEarly: true as const, code: r.code })),
      new Promise<{ diedEarly: false }>((resolve) => setTimeout(() => resolve({ diedEarly: false }), HARDWARE_ENCODER_GRACE_MS)),
    ]);
    if (graceResult.diedEarly) {
      logNative(
        `[ffmpeg] hardware encoder ${encoder} failed to start (exit ${graceResult.code}); stderr: ${spawned.stderrTailRef.current.slice(-500)} — falling back to libx264`
      );
      blacklistCurrentEncoder();
      spawned = spawnFfmpegProcess(fallbackArgsBuilder());
      encoderUsed = "libx264";
    }
  }
  return { spawned, encoderUsed };
}

function extractInputResolution(stderrText: string): string {
  const match = stderrText.match(/Video: mjpeg[^\n]*?(\d{2,5})x(\d{2,5})/);
  return match ? `${match[1]}x${match[2]}` : "unknown";
}

/** Logs a benchmark line for every Editor export (always, via logNative — safe on a
 *  packaged app with no attached terminal) and, when DOCULIGENT_EXPORT_BENCHMARK is set,
 *  also appends a structured JSON line to export-benchmark.jsonl for run-to-run comparison.
 *  `exportTimeMs` is wall-clock (spawn-to-finish, includes the frame-render loop, not just
 *  ffmpeg's own encode) — real measured time, not an estimate; `outputBitrateKbps` is
 *  computed from the actual encoded file (probeDuration + fs.stat), not assumed. */
async function logExportBenchmark(info: {
  encoderUsed: H264Encoder;
  outputWidth: number;
  outputHeight: number;
  fps: number;
  inputResolution: string;
  exportStartedAt: number;
  exportEndedAt: number;
  outputMp4Path: string;
}): Promise<void> {
  const exportTimeMs = info.exportEndedAt - info.exportStartedAt;
  let outputFileSizeBytes = 0;
  let durationSecs = 0;
  try {
    outputFileSizeBytes = (await fs.promises.stat(info.outputMp4Path)).size;
  } catch {
    // Output already moved/deleted by the time we log — size just comes back 0.
  }
  try {
    durationSecs = await probeDuration(info.outputMp4Path);
  } catch {
    // Same — leave duration/bitrate at 0 rather than fail the export over a log line.
  }
  const outputBitrateKbps = durationSecs > 0 ? Math.round((outputFileSizeBytes * 8) / durationSecs / 1000) : 0;

  const summary = {
    encoderUsed: info.encoderUsed,
    hardware: info.encoderUsed !== "libx264",
    inputResolution: info.inputResolution,
    outputResolution: `${info.outputWidth}x${info.outputHeight}`,
    fps: info.fps,
    durationSecs,
    exportTimeMs,
    outputFileSizeBytes,
    outputBitrateKbps,
  };
  logNative(`[ffmpeg] export finished: ${JSON.stringify(summary)}`);

  if (process.env.DOCULIGENT_EXPORT_BENCHMARK) {
    try {
      const file = path.join(app.getPath("userData"), "export-benchmark.jsonl");
      fs.appendFileSync(file, `${JSON.stringify({ ...summary, at: new Date().toISOString() })}\n`);
    } catch {
      // Benchmark file is opt-in diagnostics only — never fail the export over it.
    }
  }
}

/** Starts an ffmpeg process that assembles a video directly from a live stream of JPEG
 *  frames (PreviewCompositor's exportVideo — the SAME per-frame rendering the preview
 *  itself uses, streamed straight in rather than round-tripped through a browser video
 *  encoder first) muxed with an already-fully-rendered audio file (see renderExportAudio
 *  — a separate, deterministic offline pass; there is no live audio input here). No
 *  intermediate video file, and no ambiguity about frame timing the way the previous
 *  MediaRecorder-based capture had: `image2pipe`+`mjpeg` demuxes exactly the JPEGs it's
 *  given, in order, one per `1/fps` of output — there's nothing to coalesce or drop, and
 *  Node's own stdin backpressure (see writeFrame) means nothing gets silently discarded
 *  under load either, unlike CanvasCaptureMediaStreamTrack.requestFrame().
 *
 *  Video encoder is resolved via detectH264Encoder (hardware first, per-platform, with a
 *  real probe encode — see its own doc comment) and falls back to libx264 automatically,
 *  both if the probe found nothing usable and if the hardware encoder still fails once
 *  actually spawned for this export (see spawnWithFallback). Output is always MP4 + H.264
 *  + AAC either way — only which H.264 encoder does the work changes. */
export async function startImagePipeExport(
  outputMp4Path: string,
  audioWavPath: string | null,
  width: number,
  height: number,
  fps: number,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<ImagePipeExportHandle> {
  const exportStartedAt = Date.now();
  const detected = await detectH264Encoder();
  const primaryArgs = buildExportArgs(detected, audioWavPath, width, height, fps, outputMp4Path);
  const { spawned, encoderUsed } = await spawnWithFallback(detected, primaryArgs, () =>
    buildExportArgs("libx264", audioWavPath, width, height, fps, outputMp4Path)
  );
  const { proc, stderrTailRef, exited } = spawned;
  logNative(
    `[ffmpeg] export started: encoder=${encoderUsed} hardware=${encoderUsed !== "libx264"} output=${width}x${height}@${fps} args=${primaryArgs.join(" ")}`
  );

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

  const closed = exited.then(({ code }) => {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) throw new FfmpegCancelledError();
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}: ${stderrTailRef.current}`);
  });

  function writeFrame(jpeg: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (proc.exitCode !== null || proc.signalCode !== null || proc.stdin.destroyed) {
        reject(new Error("ffmpeg process is no longer accepting frames"));
        return;
      }
      const ok = proc.stdin.write(jpeg, (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else proc.stdin.once("drain", resolve);
    });
  }

  async function finish(): Promise<void> {
    if (!proc.stdin.destroyed) proc.stdin.end();
    await closed;
    await logExportBenchmark({
      encoderUsed,
      outputWidth: width,
      outputHeight: height,
      fps,
      inputResolution: extractInputResolution(stderrTailRef.current),
      exportStartedAt,
      exportEndedAt: Date.now(),
      outputMp4Path,
    });
  }

  return { writeFrame, finish };
}

/** Runs a one-shot ffmpeg re-encode job with the detected H.264 encoder (see
 *  detectH264Encoder), retrying once with libx264 if the hardware attempt fails outright.
 *  Unlike startImagePipeExport's spawnWithFallback (which only gets a short startup grace
 *  window to decide, since frames are already streaming in live by the time it could know
 *  more), these are single `run()` calls with nothing in flight to lose — "try it, catch a
 *  real failure, retry" is simpler and just as safe here. Blacklists the failed hardware
 *  encoder the same way spawnWithFallback does, so the next call (streaming or one-shot
 *  alike) skips straight to libx264 too. */
async function runReencodeWithFallback(
  buildArgs: (encoderArgs: string[]) => string[],
  width: number,
  height: number,
  fps: number,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<H264Encoder> {
  const detected = await detectH264Encoder();
  if (detected !== "libx264") {
    try {
      await run(buildArgs(videoEncoderArgs(detected, width, height, fps)), onProgress, signal);
      return detected;
    } catch (e) {
      if (e instanceof FfmpegCancelledError) throw e;
      logNative(`[ffmpeg] hardware encoder ${detected} failed during re-encode — falling back to libx264: ${e}`);
      blacklistCurrentEncoder();
    }
  }
  await run(buildArgs(videoEncoderArgs("libx264", width, height, fps)), onProgress, signal);
  return "libx264";
}

/** Same benchmark-logging idea as logExportBenchmark (see its own doc comment) but for the
 *  other two genuine re-encode paths in this file — named separately (`job`) so the three
 *  can be told apart in the log. Reads the actual output file rather than assuming, same as
 *  logExportBenchmark. */
async function logReencodeBenchmark(job: string, encoderUsed: H264Encoder, outputPath: string, startedAt: number): Promise<void> {
  const elapsedMs = Date.now() - startedAt;
  let outputFileSizeBytes = 0;
  let info: MediaInfo | null = null;
  try {
    outputFileSizeBytes = (await fs.promises.stat(outputPath)).size;
  } catch {
    // Output already moved/deleted by the time we log — size just comes back 0.
  }
  try {
    info = await probeMediaInfo(outputPath);
  } catch {
    // Leave duration/resolution unset rather than fail the job over a log line.
  }
  const durationSecs = info?.durationSecs ?? 0;
  const outputBitrateKbps = durationSecs > 0 ? Math.round((outputFileSizeBytes * 8) / durationSecs / 1000) : 0;
  logNative(
    `[ffmpeg] ${job} finished: ${JSON.stringify({
      encoderUsed,
      hardware: encoderUsed !== "libx264",
      elapsedMs,
      outputResolution: info?.width && info?.height ? `${info.width}x${info.height}` : "unknown",
      durationSecs,
      outputFileSizeBytes,
      outputBitrateKbps,
    })}`
  );
}

/** Re-encodes an arbitrary input (typically a MediaRecorder-produced side clip — VP9/WebM,
 *  or already H.264/MP4 when pickMimeType's preference was available — see
 *  RecordingService.ts) into H.264/AAC MP4. Despite the name this is always a genuine
 *  re-encode, not a remux — kept for call-site compatibility. Callers that already know the
 *  source is H.264/MP4 and don't need a real transcode should call `copyToMp4` instead (see
 *  recording.ts's buildFinalMp4/buildEditProjectMaterials, which do exactly that). Uses the
 *  detected hardware H.264 encoder when one is available, falling back to libx264 with a
 *  deterministic quality target (crf 18, not the encoder's own default) otherwise. */
export async function remuxToMp4(
  inputPath: string,
  outputMp4Path: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  const startedAt = Date.now();
  const sourceInfo = await probeMediaInfo(inputPath);
  const width = sourceInfo.width ?? 1920;
  const height = sourceInfo.height ?? 1080;
  const encoderUsed = await runReencodeWithFallback(
    (encoderArgs) => [
      "-y",
      "-i",
      inputPath,
      ...encoderArgs,
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      outputMp4Path,
    ],
    width,
    height,
    30,
    onProgress,
    signal
  );
  await logReencodeBenchmark("remuxToMp4", encoderUsed, outputMp4Path, startedAt);
}

/** Turns a raw, uncropped/unscaled screen recording (the non-native fallback's own
 *  MediaRecorder output — see native/screenCapture.ts's `vfFor` for what a native gdigrab
 *  capture already bakes in at capture time) into the same shape `metadata/screen.mp4`
 *  has for a native recording, so everything downstream (camera-bubble overlay, cursor
 *  overlay, Edit-page playback) can treat the two identically. No audio — this stream was
 *  always requested video-only (see desktopConstraints), same as gdigrab.
 *
 *  Always a real re-encode regardless of the source's own codec — `vf` applies a genuine
 *  pixel transform (crop and/or scale/pad), so there's no `-c copy` shortcut available even
 *  when the input is already H.264. Uses the detected hardware H.264 encoder the same way
 *  remuxToMp4 does, falling back to libx264 (crf 18, not the old fixed `ultrafast` preset —
 *  now that a hardware encoder is the primary path on capable machines, the software
 *  fallback can afford the same deterministic quality target as everywhere else instead of
 *  trading it away for speed). */
export async function transcodeScreenRecording(
  inputPath: string,
  outputMp4Path: string,
  vf: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  const startedAt = Date.now();
  const sourceInfo = await probeMediaInfo(inputPath);
  const width = sourceInfo.width ?? 1920;
  const height = sourceInfo.height ?? 1080;
  const encoderUsed = await runReencodeWithFallback(
    (encoderArgs) => ["-y", "-i", inputPath, "-vf", vf, ...encoderArgs, "-an", outputMp4Path],
    width,
    height,
    30,
    onProgress,
    signal
  );
  await logReencodeBenchmark("transcodeScreenRecording", encoderUsed, outputMp4Path, startedAt);
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

export interface MediaInfo {
  durationSecs: number;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
}

/** One `ffmpeg -i` probe covering duration + codecs + resolution — used by library import to
 *  decide copy-vs-transcode (see library.ts's transcodeIntoLibrary) instead of the plain
 *  probeDuration above, which only ever looks at the Duration: line, and by the re-encode
 *  paths below (remuxToMp4/transcodeScreenRecording) to size a hardware encoder's bitrate to
 *  the actual source resolution rather than guessing. */
export function probeMediaInfo(filePath: string): Promise<MediaInfo> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ["-i", filePath]);
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", () => resolve({ durationSecs: 0, videoCodec: null, audioCodec: null, width: null, height: null }));
    proc.on("close", () => {
      const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const durationSecs = durationMatch
        ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
        : 0;
      const videoLine = stderr.match(/Stream #\d+:\d+[^\n]*?: Video: ([^\n]*)/)?.[1] ?? null;
      const videoCodec = videoLine?.match(/^(\w+)/)?.[1]?.toLowerCase() ?? null;
      const dimensions = videoLine?.match(/\b(\d{2,5})x(\d{2,5})\b/);
      const audioCodec = stderr.match(/Stream #\d+:\d+[^\n]*?: Audio: (\w+)/)?.[1]?.toLowerCase() ?? null;
      resolve({
        durationSecs,
        videoCodec,
        audioCodec,
        width: dimensions ? Number(dimensions[1]) : null,
        height: dimensions ? Number(dimensions[2]) : null,
      });
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

/** Copies the video stream untouched and only transcodes audio — for an imported file
 *  whose video is already H.264 but whose audio isn't AAC (e.g. a .mov with PCM audio):
 *  avoids the far more expensive full video re-encode `remuxToMp4` would do, since only the
 *  audio actually needs converting. */
export function copyVideoTranscodeAudio(
  inputPath: string,
  outputMp4Path: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  return run(
    ["-y", "-i", inputPath, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputMp4Path],
    onProgress,
    signal
  );
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
