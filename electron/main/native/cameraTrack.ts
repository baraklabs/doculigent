import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { CameraTrackMetadata, CameraTrackPoint } from "@shared/types/models";
import { getCameraBubbleBounds } from "../cameraBubbleWindow";

const SAMPLE_RATE_HZ = 20;
const SAMPLE_INTERVAL_MS = Math.round(1000 / SAMPLE_RATE_HZ);

interface ActiveTrack {
  startedAt: number;
  points: CameraTrackPoint[];
}

let timer: ReturnType<typeof setInterval> | null = null;
let track: ActiveTrack | null = null;

export function startCameraTrack(): void {
  stopCameraTrack();
  console.log("[cameraTrack] startCameraTrack", { initialBounds: getCameraBubbleBounds() });
  track = { startedAt: Date.now(), points: [] };

  timer = setInterval(() => {
    if (!track) return;
    const bounds = getCameraBubbleBounds();
    if (!bounds) return;
    const last = track.points[track.points.length - 1];
    if (last && last.x === bounds.x && last.y === bounds.y && last.width === bounds.width && last.height === bounds.height) {
      return;
    }
    track.points.push({
      t: Date.now() - track.startedAt,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
  }, SAMPLE_INTERVAL_MS);
}

export function stopCameraTrack(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function writeCameraMetadata(recordingId: string, recordingDir: string): Promise<void> {
  const captured = track;
  track = null;
  console.log("[cameraTrack] writeCameraMetadata", { points: captured?.points.length ?? 0 });
  if (!captured || captured.points.length === 0) return;

  const metadata: CameraTrackMetadata = {
    appVersion: app.getVersion(),
    recordingId,
    createdAt: new Date().toISOString(),
    sampleRateHz: SAMPLE_RATE_HZ,
    points: captured.points,
  };

  try {
    const dir = path.join(recordingDir, "metadata");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "camera.json"), JSON.stringify(metadata), "utf-8");
  } catch (e) {
    console.error("Couldn't write camera metadata:", e);
  }
}
