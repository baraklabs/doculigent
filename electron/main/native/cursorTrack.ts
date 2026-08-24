import { desktopCapturer, screen } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { AreaRect, CursorIconAsset, CursorMetadata, CursorTrackPoint } from "@shared/types/models";
import {
  captureCursorBitmap,
  pollLeftButton,
  renderFallbackArrowPng,
  rgbaToPng,
  sampleCursorShape,
  FALLBACK_ICON,
} from "./cursorIcon";
import { captureTimelineMs } from "./screenCapture";
import { getDockWindowBoundsIfVisible, getMainWindowBounds } from "../recordingDockWindow";
import { getCameraBubbleBoundsIfVisible } from "../cameraBubbleWindow";

const SAMPLE_RATE_HZ = 60;
const SAMPLE_INTERVAL_MS = Math.round(1000 / SAMPLE_RATE_HZ);

type IconEntry =
  | { kind: "fallback" }
  | { kind: "captured"; hotspotX: number; hotspotY: number; width: number; height: number; rgba: Buffer };

interface ActiveTrack {
  startedAt: number;
  capture: CursorMetadata["capture"];
  points: CursorTrackPoint[];
  icons: IconEntry[];
  shapeIndex: Map<string, number>;
  fallbackIndex: number | null;
  clicks: number[];
}

let timer: ReturnType<typeof setInterval> | null = null;
let track: ActiveTrack | null = null;

export async function describeCapture(targetId: string, area: AreaRect | null): Promise<CursorMetadata["capture"]> {
  const kind: "display" | "window" | "area" = !targetId.startsWith("screen:")
    ? "window"
    : area
      ? "area"
      : "display";
  if (kind === "window") {
    return { targetId, kind, bounds: null, scaleFactor: screen.getPrimaryDisplay().scaleFactor };
  }

  let display = screen.getPrimaryDisplay();
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    const source = sources.find((s) => s.id === targetId);
    display = screen.getAllDisplays().find((d) => String(d.id) === source?.display_id) ?? display;
  } catch {
  }

  const bounds = area
    ? {
        x: display.bounds.x + Math.round(area.x * display.bounds.width),
        y: display.bounds.y + Math.round(area.y * display.bounds.height),
        width: Math.round(area.width * display.bounds.width),
        height: Math.round(area.height * display.bounds.height),
      }
    : { ...display.bounds };
  return { targetId, kind, bounds, scaleFactor: display.scaleFactor };
}

function fallbackIconIndex(t: ActiveTrack): number {
  if (t.fallbackIndex === null) {
    t.fallbackIndex = t.icons.length;
    t.icons.push({ kind: "fallback" });
  }
  return t.fallbackIndex;
}

function resolveIconIndex(t: ActiveTrack): number {
  const shape = sampleCursorShape();
  if (!shape) return fallbackIconIndex(t);

  const existing = t.shapeIndex.get(shape.key);
  if (existing !== undefined) return existing;

  const bitmap = captureCursorBitmap(shape.hCursor);
  const index = bitmap
    ? t.icons.push({ kind: "captured", ...bitmap }) - 1
    : fallbackIconIndex(t);
  t.shapeIndex.set(shape.key, index);
  return index;
}

function inside(x: number, y: number, b: { x: number; y: number; width: number; height: number } | null): boolean {
  return !!b && x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
}

/** True for a click that shouldn't count as part of the recording — either it landed on
 *  Doculigent's own floating UI (main window, recording dock, camera bubble — none of
 *  which are the thing being recorded, even when one of them happens to be visible), or,
 *  for a display/area capture, it landed on a monitor other than the one actually being
 *  captured. Window-target captures have no known bounds to check against here (see
 *  describeCapture) — `capture.bounds` is null for those, and inside(x, y, null) already
 *  returns false, so this only ever excludes the Doculigent-UI cases for that kind. */
function isOffRecordingClick(x: number, y: number, capture: CursorMetadata["capture"]): boolean {
  if (inside(x, y, getMainWindowBounds())) return true;
  if (inside(x, y, getDockWindowBoundsIfVisible())) return true;
  if (inside(x, y, getCameraBubbleBoundsIfVisible())) return true;
  if (capture.kind !== "window" && capture.bounds && !inside(x, y, capture.bounds)) return true;
  return false;
}

export async function startCursorTrack(targetId: string, area: AreaRect | null = null): Promise<void> {
  stopCursorTrack();
  const capture = await describeCapture(targetId, area);
  track = {
    startedAt: Date.now(),
    capture,
    points: [],
    icons: [],
    shapeIndex: new Map(),
    fallbackIndex: null,
    clicks: [],
  };

  timer = setInterval(() => {
    if (!track) return;

    const { x, y } = screen.getCursorScreenPoint();

    if (pollLeftButton().wasPressed && !isOffRecordingClick(x, y, track.capture)) {
      track.clicks.push(Date.now() - track.startedAt);
    }

    const last = track.points[track.points.length - 1];
    if (last && last.x === x && last.y === y) return;
    track.points.push({ t: Date.now() - track.startedAt, x, y, icon: resolveIconIndex(track) });
  }, SAMPLE_INTERVAL_MS);
}

export function stopCursorTrack(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function writeCursorMetadata(recordingId: string, recordingDir: string): Promise<void> {
  const captured = track;
  track = null;
  if (!captured) return;

  try {
    const metaDir = path.join(recordingDir, "metadata");
    const iconsDir = path.join(metaDir, "cursor-icons");
    await fs.mkdir(iconsDir, { recursive: true });

    // Points/clicks were stamped as Date.now() offsets from this tracker's own start
    // (startCursorTrack fires as soon as the renderer asks for it, well before the
    // recording's real t=0 — see RecordingService.start()), not from the video's first
    // captured frame. Re-anchor each one onto the video's own timeline here via the main
    // process's capture clock (see native/screenCapture.ts), now that recording has
    // stopped and the whole mapping is known, and drop anything that lands before the
    // video started or inside a paused span — otherwise the synthetic cursor drawn in the
    // editor visibly leads the picture, most obviously during a drag.
    const points: CursorTrackPoint[] = [];
    for (const p of captured.points) {
      const t = captureTimelineMs(captured.startedAt + p.t);
      if (t !== null) points.push({ ...p, t });
    }
    const clicks: number[] = [];
    for (const c of captured.clicks) {
      const t = captureTimelineMs(captured.startedAt + c);
      if (t !== null) clicks.push(t);
    }

    const icons: CursorIconAsset[] = [];
    for (let i = 0; i < captured.icons.length; i++) {
      const entry = captured.icons[i];
      const file = `${i}.png`;
      const outPath = path.join(iconsDir, file);
      if (entry.kind === "fallback") {
        await renderFallbackArrowPng(outPath);
        icons.push({ file, width: FALLBACK_ICON.width, height: FALLBACK_ICON.height, hotspotX: FALLBACK_ICON.hotspotX, hotspotY: FALLBACK_ICON.hotspotY });
      } else {
        await rgbaToPng(entry.rgba, entry.width, entry.height, outPath);
        icons.push({ file, width: entry.width, height: entry.height, hotspotX: entry.hotspotX, hotspotY: entry.hotspotY });
      }
    }

    const metadata: CursorMetadata = {
      appVersion: app.getVersion(),
      recordingId,
      createdAt: new Date().toISOString(),
      capture: captured.capture,
      sampleRateHz: SAMPLE_RATE_HZ,
      icons,
      points,
      clicks,
    };
    await fs.writeFile(path.join(metaDir, "cursor.json"), JSON.stringify(metadata), "utf-8");
    console.log("[cursorTrack] wrote cursor.json", {
      points: metadata.points.length,
      clicks: metadata.clicks?.length,
      icons: metadata.icons.length,
      captureKind: metadata.capture.kind,
    });
  } catch (e) {
    console.error("Couldn't write cursor metadata:", e);
  }
}
