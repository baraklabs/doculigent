/**
 * Samples where the mouse pointer is for the duration of a recording, so the Edit section
 * can re-draw the cursor in any style later — the approach Screen Studio / Focusee /
 * Cursorful take. Whether the frames themselves are clean depends on which capture
 * pipeline ran this recording: the default "hidden" style genuinely excludes the pointer
 * from the video on the native gdigrab path (see native/screenCapture.ts), with the real
 * pointer never touched on screen; on the ordinary getUserMedia/MediaRecorder pipeline
 * (non-Windows, or a specific-window target) Chromium always bakes whatever cursor is on
 * screen into the frames regardless of style, so an Edit-side cursor there is drawn on top
 * of the real one rather than replacing it.
 *
 * Sampling has to happen here rather than in the renderer: only the main process can see
 * the global pointer (screen.getCursorScreenPoint), and its timers aren't subject to the
 * renderer's background throttling.
 *
 * Not captured: button state. Electron exposes no global mouse-event hook, and pulling in
 * a native one for it isn't worth it yet — clicks would need something like uiohook.
 */
import { desktopCapturer, screen } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import type { CursorHighlightStyle, CursorMetadata, CursorTrackPoint } from "@shared/types/models";

const SAMPLE_RATE_HZ = 60;
const SAMPLE_INTERVAL_MS = Math.round(1000 / SAMPLE_RATE_HZ);

interface ActiveTrack {
  startedAt: number;
  cursorStyle: CursorHighlightStyle;
  capture: CursorMetadata["capture"];
  points: CursorTrackPoint[];
}

let timer: ReturnType<typeof setInterval> | null = null;
let track: ActiveTrack | null = null;

/** Resolves the captured display via desktopCapturer's `display_id`, which is the only
 *  reliable link between a source id like "screen:0:0" and an Electron Display. */
async function describeCapture(targetId: string): Promise<CursorMetadata["capture"]> {
  const kind: "display" | "window" = targetId.startsWith("screen:") ? "display" : "window";
  if (kind === "window") {
    return { targetId, kind, bounds: null, scaleFactor: screen.getPrimaryDisplay().scaleFactor };
  }
  try {
    const sources = await desktopCapturer.getSources({ types: ["screen"] });
    const source = sources.find((s) => s.id === targetId);
    const display =
      screen.getAllDisplays().find((d) => String(d.id) === source?.display_id) ?? screen.getPrimaryDisplay();
    return { targetId, kind, bounds: { ...display.bounds }, scaleFactor: display.scaleFactor };
  } catch {
    const display = screen.getPrimaryDisplay();
    return { targetId, kind, bounds: { ...display.bounds }, scaleFactor: display.scaleFactor };
  }
}

export async function startCursorTrack(targetId: string, cursorStyle: CursorHighlightStyle): Promise<void> {
  stopCursorTrack();
  const capture = await describeCapture(targetId);
  track = { startedAt: Date.now(), cursorStyle, capture, points: [] };

  timer = setInterval(() => {
    if (!track) return;
    const { x, y } = screen.getCursorScreenPoint();
    const last = track.points[track.points.length - 1];
    // Unchanged positions are dropped: a still pointer would otherwise add 60 identical
    // samples a second, and "no sample" already means "didn't move".
    if (last && last.x === x && last.y === y) return;
    track.points.push({ t: Date.now() - track.startedAt, x, y });
  }, SAMPLE_INTERVAL_MS);
}

/** Stops sampling but keeps the track in memory — `writeCursorMetadata` collects it once
 *  the save handler knows the recording's id and folder. */
export function stopCursorTrack(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Writes `<recordingDir>/metadata/cursor.json` and clears the buffered track. Silent no-op
 * when nothing was captured (e.g. the audio-only Meeting path). Best-effort: a recording
 * that saved fine shouldn't fail because its sidecar couldn't be written.
 */
export async function writeCursorMetadata(recordingId: string, recordingDir: string): Promise<void> {
  const captured = track;
  track = null;
  if (!captured) return;

  const metadata: CursorMetadata = {
    appVersion: app.getVersion(),
    recordingId,
    createdAt: new Date().toISOString(),
    cursorStyle: captured.cursorStyle,
    capture: captured.capture,
    sampleRateHz: SAMPLE_RATE_HZ,
    points: captured.points,
  };

  try {
    const dir = path.join(recordingDir, "metadata");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "cursor.json"), JSON.stringify(metadata), "utf-8");
  } catch (e) {
    console.error("Couldn't write cursor metadata:", e);
  }
}
