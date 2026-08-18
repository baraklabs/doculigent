import { spawn } from "node:child_process";
import ffmpegStaticPath from "ffmpeg-static";
import path from "node:path";
import type { CursorMetadata } from "@shared/types/models";
import { frameDimensions, toFrameCoords } from "@shared/lib/cursorFrame";

export { frameDimensions, toFrameCoords } from "@shared/lib/cursorFrame";

const ffmpegPath = (ffmpegStaticPath ?? "ffmpeg").replace("app.asar", "app.asar.unpacked");
const OVERLAY_FPS = 30;

type ProgressHandler = (secondsDone: number) => void;

interface LoadedIcon {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  rgba: Buffer;
}

function decodePngToRgba(pngPath: string, width: number, height: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-i", pngPath, "-f", "rawvideo", "-pixel_format", "rgba", "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    proc.once("error", reject);
    proc.once("close", (code) => {
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length === width * height * 4) resolve(buf);
      else reject(new Error(`decode cursor icon failed (code ${code}, ${buf.length}/${width * height * 4}b): ${stderr.slice(-300)}`));
    });
  });
}

export async function loadCursorIcons(metadata: CursorMetadata, iconsDir: string): Promise<LoadedIcon[]> {
  const icons: LoadedIcon[] = [];
  for (const asset of metadata.icons) {
    const rgba = await decodePngToRgba(path.join(iconsDir, asset.file), asset.width, asset.height);
    icons.push({ width: asset.width, height: asset.height, hotspotX: asset.hotspotX, hotspotY: asset.hotspotY, rgba });
  }
  return icons;
}

function blit(canvas: Buffer, canvasW: number, canvasH: number, icon: LoadedIcon, x: number, y: number): void {
  const left = Math.round(x - icon.hotspotX);
  const top = Math.round(y - icon.hotspotY);
  for (let iy = 0; iy < icon.height; iy++) {
    const cy = top + iy;
    if (cy < 0 || cy >= canvasH) continue;
    for (let ix = 0; ix < icon.width; ix++) {
      const cx = left + ix;
      if (cx < 0 || cx >= canvasW) continue;
      const srcIdx = (iy * icon.width + ix) * 4;
      const alpha = icon.rgba[srcIdx + 3];
      if (alpha === 0) continue;
      const dstIdx = (cy * canvasW + cx) * 4;
      canvas[dstIdx] = icon.rgba[srcIdx];
      canvas[dstIdx + 1] = icon.rgba[srcIdx + 1];
      canvas[dstIdx + 2] = icon.rgba[srcIdx + 2];
      canvas[dstIdx + 3] = alpha;
    }
  }
}

export async function overlayCursorTrack(
  inputVideoPath: string,
  metadata: CursorMetadata,
  icons: LoadedIcon[],
  durationSecs: number,
  outputMp4Path: string,
  onProgress?: ProgressHandler,
  signal?: AbortSignal
): Promise<void> {
  const { width, height } = frameDimensions(metadata);
  const totalFrames = Math.max(1, Math.round(durationSecs * OVERLAY_FPS));

  const args = [
    "-y",
    "-i",
    inputVideoPath,
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgba",
    "-video_size",
    `${width}x${height}`,
    "-framerate",
    String(OVERLAY_FPS),
    "-i",
    "pipe:0",
    "-filter_complex",
    "[0:v][1:v]overlay=x=0:y=0:format=auto[out]",
    "-map",
    "[out]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-c:a",
    "copy",
    "-progress",
    "pipe:1",
    "-nostats",
    outputMp4Path,
  ];

  const STALL_MS = 30_000;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    let lastActivity = Date.now();
    const markActivity = () => {
      lastActivity = Date.now();
    };

    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > STALL_MS) proc.kill();
    }, 5_000);

    proc.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    let pending = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      markActivity();
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const [key, value] = line.trim().split("=");
        if (key === "out_time_us" && value && value !== "N/A") {
          const seconds = Number(value) / 1_000_000;
          if (Number.isFinite(seconds)) onProgress?.(seconds);
        }
      }
    });
    const onAbort = () => proc.kill();
    if (signal) {
      if (signal.aborted) proc.kill();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    proc.once("error", (e) => finish(() => reject(e)));
    proc.once("close", (code) => {
      finish(() => {
        if (signal?.aborted) reject(new Error("cursor overlay cancelled"));
        else if (Date.now() - lastActivity > STALL_MS) reject(new Error("cursor overlay ffmpeg stalled, killed"));
        else if (code === 0) resolve();
        else reject(new Error(`cursor overlay ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
      });
    });

    void streamFrames(proc.stdin, metadata, icons, width, height, totalFrames, markActivity).catch((e) =>
      finish(() => reject(e))
    );
  });
}

function streamFrames(
  stdin: NodeJS.WritableStream,
  metadata: CursorMetadata,
  icons: LoadedIcon[],
  width: number,
  height: number,
  totalFrames: number,
  markActivity: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let failed = false;
    const onError = (e: Error) => {
      failed = true;
      reject(e);
    };
    stdin.once("error", onError);

    (async () => {
      const points = metadata.points;
      let pointCursor = 0;

      for (let frame = 0; frame < totalFrames && !failed; frame++) {
        const tMs = (frame / OVERLAY_FPS) * 1000;
        while (pointCursor + 1 < points.length && points[pointCursor + 1].t <= tMs) pointCursor++;

        const canvas = Buffer.alloc(width * height * 4);
        const point = points[pointCursor];
        if (point && (points.length === 1 || point.t <= tMs + 1000)) {
          const pos = toFrameCoords(metadata, point.x, point.y);
          const icon = icons[point.icon];
          if (pos && icon) blit(canvas, width, height, icon, pos.x, pos.y);
        }
        markActivity();
        if (!stdin.write(canvas)) {
          await new Promise<void>((res) => stdin.once("drain", res));
        }
      }
      if (!failed) {
        stdin.removeListener("error", onError);
        stdin.end();
        resolve();
      }
    })().catch(reject);
  });
}
