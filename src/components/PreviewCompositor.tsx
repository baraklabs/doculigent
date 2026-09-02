import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pause, Play, Redo2, Undo2, Volume2, VolumeX } from "lucide-react";
import {
  BACKGROUND_COLORS,
  BACKGROUND_GRADIENTS,
  ZOOM_TRANSITION_MS,
  type BackgroundEditSettings,
  type BackgroundGradientPreset,
  type CameraEditSettings,
  type CursorEditSettings,
  type CursorMetadata,
  type LayoutEditSettings,
  type SoundEditSettings,
  type TimelineEditSettings,
  type TimelineZoom,
} from "@shared/types/models";
import { frameDimensions, toFrameCoords } from "@shared/lib/cursorFrame";
import { effectiveClips, resolveClipAt, sourceToEditedMs, splitClipAtSource, totalClipsExtentMs } from "@shared/lib/timelineClips";
import type { TimelineClip } from "@shared/types/models";
import { mediaUrl } from "@shared/constants/media";
import { BACKGROUND_IMAGE_URLS, BACKGROUND_TEXTURE_URLS } from "../assets/backgrounds";
import { applyCameraBlur, type CameraBlurHandle } from "../services/camera/cameraBlur";
import type { TimelineTool } from "./Timeline";
import "./PreviewCompositor.css";

interface PreviewCompositorProps {
  screenFilePath: string;
  /** Only set when the source kept the camera as a separate, re-editable track —
   *  otherwise the camera bubble (if any) is already burned into screenFilePath. */
  cameraFilePath?: string;
  /** A screen-only recording's own separately-captured mic/system audio (see
   *  EditProjectMedia.audioFilePath) — only ever set when cameraFilePath isn't, since
   *  screenFilePath's own native capture is video-only in that case and there's no camera
   *  track to carry audio instead. Always shares screenFilePath's own clip list (there's
   *  no independent editing for it) — see the draw loop's audio-only sync. */
  audioFilePath?: string;
  /** How many ms into screenFilePath's own timeline cameraFilePath/audioFilePath's own t=0
   *  actually falls — see EditProjectMedia.sideClipStartOffsetMs. Drives both the Camera
   *  track's default (unedited) clip position and the audio-only element's live-preview/
   *  export sync — without it, that side clip's video and audio both visibly lead the
   *  screen content by exactly this much (it was recorded by a separate MediaRecorder,
   *  started after screen capture is already rolling and after camera/mic getUserMedia
   *  resolves). Null/undefined treated as 0 (no measurement, or genuinely no side clip). */
  sideClipStartOffsetMs?: number | null;
  /** Recorded cursor track — screenFilePath never has the cursor burned in, so it's
   *  rendered live here from the same track used to burn it into the final export. */
  cursorMetadataPath?: string | null;
  cursorIconsDir?: string | null;
  /** True when screenFilePath already has a real, physically-captured OS cursor baked
   *  into its pixels (the non-native screen-capture fallback — see
   *  EditProjectMedia.cursorBakedIn) — drawing the synthetic track on top of one of these
   *  would show two cursors, so the draw loop skips it entirely. */
  cursorBakedIn?: boolean;
  camera: CameraEditSettings;
  onCameraChange: (next: CameraEditSettings) => void;
  background: BackgroundEditSettings;
  cursor: CursorEditSettings;
  layout: LayoutEditSettings;
  onLayoutChange: (next: LayoutEditSettings) => void;
  sound: SoundEditSettings;
  onSoundChange: (next: SoundEditSettings) => void;
  timeline: TimelineEditSettings;
  onTimelineChange: (next: TimelineEditSettings) => void;
  /** Controlled from EditPage — the same Default/Cut toggle rendered in the Timeline
   *  component's ruler row governs what clicking this canvas does. */
  tool: TimelineTool;
  /** Fired every animation frame with the resolved playhead/duration (ms) — drives the
   *  Timeline component's ruler and playhead without it needing its own video element.
   *  `sourceDurationMs` is the raw recording's own length — distinct from `durationMs`
   *  (the edited timeline's extent) once clips have been trimmed, moved, or overlapped —
   *  and is how far a clip's trim handles can reveal hidden footage back out to. */
  onTimeUpdate?: (currentMs: number, durationMs: number, sourceDurationMs: number) => void;
  /** Undo/redo for the whole edit session (every tab's settings and the Timeline) — the
   *  history itself lives in EditPage, this just renders the buttons next to Mute. */
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

export class ExportCancelledError extends Error {
  constructor() {
    super("export cancelled");
    this.name = "ExportCancelledError";
  }
}

export interface PreviewCompositorHandle {
  seekMs: (ms: number) => void;
  togglePlay: () => void;
  /** Renders the export frame-by-frame (same camera/background/cursor/zoom/cuts drawing
   *  the live preview uses) and streams it straight out via the callbacks below, rather
   *  than assembling a video client-side — the caller (ExportDialog) is what actually
   *  knows how to turn a stream of frames + a rendered audio track into a file (feeding
   *  them to a main-process ffmpeg process — see startImagePipeExport), this just drives
   *  that process with the right data at the right time.
   *
   *  `fps`/`width`/`height` are the real output settings: frames are rendered on a canvas
   *  of fixed native size, then encoded at `width`x`height` by the h264 sink (which
   *  scales, because the `-c:v copy` mux downstream cannot). On the mjpeg fallback the
   *  canvas size is streamed as-is and ffmpeg scales instead — `beginExport` is told which
   *  of the two is happening. Returns a cancelable handle rather than a bare promise so a
   *  long export can be aborted mid-flight. */
  exportVideo: (opts: {
    fps: number;
    width: number;
    height: number;
    onProgress?: (fraction: number) => void;
    /** Runs a source file through ffmpeg and returns its audio as WAV bytes — used by the
     *  offline audio render (see renderExportAudio) instead of decoding the raw source
     *  file directly in the browser, which doesn't reliably decode a MediaRecorder-
     *  produced webm's full length (no proper duration/seek index in that container). */
    decodeAudio: (filePath: string) => Promise<ArrayBuffer>;
    /** Called once, after audio has been fully rendered offline and after the frame sink
     *  has been chosen, but before any frame is produced — the caller uses this to open
     *  its save dialog / spawn whatever process will receive the frames (see onFrame),
     *  which needs `frameFormat` to know which pipeline to set up. Resolving false (e.g.
     *  the save dialog was dismissed) cancels before any frame work begins. */
    beginExport: (info: {
      durationSecs: number;
      audioWavBytes: ArrayBuffer | null;
      frameFormat: "h264" | "mjpeg";
      sourceWidth: number;
      sourceHeight: number;
    }) => Promise<boolean>;
    /** One frame's bytes, in output order — an Annex-B H.264 access unit, or a whole JPEG
     *  on the mjpeg fallback. Awaited before the next frame is handed over, which is this
     *  pipeline's backpressure against whatever's consuming them downstream. */
    onFrame: (frameBytes: ArrayBuffer) => Promise<void>;
  }) => { promise: Promise<void>; cancel: () => void };
}

interface LoadedCursorIcon {
  img: HTMLImageElement;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const UNDO_SHORTCUT_LABEL = IS_MAC ? "⌘Z" : "Ctrl+Z";
const REDO_SHORTCUT_LABEL = IS_MAC ? "⇧⌘Z" : "Ctrl+Shift+Z";

const MAX_BACKGROUND_BLUR_PX = 30;
const FALLBACK_BACKGROUND = "#14161f"; // matches .edit-preview's own background
const RECT_ASPECT = 1.6; // matches the live camera bubble's rectangle aspect ratio
const STACK_CANVAS_WIDTH = 1080; // "reel" format — fixed 9:16 portrait canvas
const STACK_CANVAS_HEIGHT = 1920;
const WIDE_CANVAS_WIDTH = 1920; // "overlay"/"split" formats — fixed 16:9 canvas
const WIDE_CANVAS_HEIGHT = 1080;
const RIPPLE_DURATION_MS = 450;
const GUIDE_COLOR = "#ff3b30"; // snap guide lines drawn while dragging screen/camera
const GUIDE_FRACTIONS = [0.25, 0.5, 0.75]; // snap points along each axis, as a fraction of canvas size
const DRAG_MOVE_THRESHOLD_PX = 3; // below this, a pointerdown+up is treated as a click (toggles play), not a drag
const SNAP_SCREEN_PX = 8; // guide-line snap tolerance, in on-screen CSS px (converted to canvas px per-format — see canvasDisplayScale)

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Which corner of a box: the letters name the handle's own position ("tl" = top-left),
 *  not the corner that stays fixed while dragging it — that's always the *opposite* one. */
type Corner = "tl" | "tr" | "bl" | "br";
const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];

function cornerHandles(box: Rect, size: number): Record<Corner, Rect> {
  const half = size / 2;
  return {
    tl: { x: box.x - half, y: box.y - half, w: size, h: size },
    tr: { x: box.x + box.w - half, y: box.y - half, w: size, h: size },
    bl: { x: box.x - half, y: box.y + box.h - half, w: size, h: size },
    br: { x: box.x + box.w - half, y: box.y + box.h - half, w: size, h: size },
  };
}

/** A drag-positioned box's travel range in canvas pixel space — its FreePosition
 *  (0-100 xPct/yPct) maps onto [originX, originX + travelW] etc., so any stored
 *  percentage is automatically a valid, in-bounds top-left for that box's current size. */
interface DragRegion {
  originX: number;
  originY: number;
  travelW: number;
  travelH: number;
  boxW: number;
  boxH: number;
}

// Below this (px), "percent of travel" is a singularity, not just a sensitive scale — a
// box exactly as wide/tall as the canvas (e.g. any reel "(full)" layout) has *zero* travel
// on that axis, so dividing a drag distance by it to get a percentage (and later
// multiplying that percentage back by the same zero to redraw it) throws away the drag
// entirely: every xPct reads back as the same position, no matter how far you dragged.
// offsetToPct/pctToOffset below fall back to a plain pixel offset around the pct=50
// "centered" point instead, so the ~50 that every relevant preset already stores for a
// full-bleed axis still lands exactly on-canvas, but an actual drag away from it is no
// longer silently discarded.
const DEGENERATE_TRAVEL_PX = 0.5;

function pctToOffset(pct: number, travel: number): number {
  return Math.abs(travel) < DEGENERATE_TRAVEL_PX ? pct - 50 : (pct / 100) * travel;
}

function offsetToPct(offset: number, travel: number): number {
  return Math.abs(travel) < DEGENERATE_TRAVEL_PX ? offset + 50 : (offset / travel) * 100;
}

function resolveDragPos(pos: { xPct: number; yPct: number } | null, region: DragRegion, defaultPct: { x: number; y: number }): { x: number; y: number } {
  const xPct = pos?.xPct ?? defaultPct.x;
  const yPct = pos?.yPct ?? defaultPct.y;
  return {
    x: region.originX + pctToOffset(xPct, region.travelW),
    y: region.originY + pctToOffset(yPct, region.travelH),
  };
}

// Synthetic "arrow"/"hand" cursor styles reuse lucide's own icon paths (24x24 viewBox)
// so they render exactly as they preview in the panel, instead of a hand-drawn approximation.
const ARROW_ICON_PATH = new Path2D(
  "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"
);
const ARROW_HOTSPOT = { x: 4.037, y: 4.688 }; // tip of the arrow
// "Hand" — Phosphor Icons' hand-pointing/hand-grabbing glyphs (256x256 viewBox), which
// ship real "regular" (thin/outline-weight) and "fill" (bold/solid-weight) path pairs —
// unlike lucide's open line-art strokes, both are genuine closed, fillable shapes.
const HAND_POINTING_REGULAR_PATH = new Path2D(
  "M196,88a27.86,27.86,0,0,0-13.35,3.39A28,28,0,0,0,144,74.7V44a28,28,0,0,0-56,0v80l-3.82-6.13A28,28,0,0,0,35.73,146l4.67,8.23C74.81,214.89,89.05,240,136,240a88.1,88.1,0,0,0,88-88V116A28,28,0,0,0,196,88Zm12,64a72.08,72.08,0,0,1-72,72c-37.63,0-47.84-18-81.68-77.68l-4.69-8.27,0-.05A12,12,0,0,1,54,121.61a11.88,11.88,0,0,1,6-1.6,12,12,0,0,1,10.41,6,1.76,1.76,0,0,0,.14.23l18.67,30A8,8,0,0,0,104,152V44a12,12,0,0,1,24,0v68a8,8,0,0,0,16,0V100a12,12,0,0,1,24,0v20a8,8,0,0,0,16,0v-4a12,12,0,0,1,24,0Z"
);
const HAND_POINTING_FILL_PATH = new Path2D(
  "M224,104v50.93c0,46.2-36.85,84.55-83,85.06A83.71,83.71,0,0,1,80.6,215.4C58.79,192.33,34.15,136,34.15,136a16,16,0,0,1,6.53-22.23c7.66-4,17.1-.84,21.4,6.62l21,36.44a6.09,6.09,0,0,0,6,3.09l.12,0A8.19,8.19,0,0,0,96,151.74V32a16,16,0,0,1,16.77-16c8.61.4,15.23,7.82,15.23,16.43V104a8,8,0,0,0,8.53,8,8.17,8.17,0,0,0,7.47-8.25V88a16,16,0,0,1,16.77-16c8.61.4,15.23,7.82,15.23,16.43V112a8,8,0,0,0,8.53,8,8.17,8.17,0,0,0,7.47-8.25v-7.28c0-8.61,6.62-16,15.23-16.43A16,16,0,0,1,224,104Z"
);
const HAND_POINTING_HOTSPOT = { x: 116, y: 16 }; // tip of the extended index finger

// "Mouse" — Phosphor's mouse-simple glyph.
const MOUSE_SIMPLE_REGULAR_PATH = new Path2D(
  "M144,16H112A64.07,64.07,0,0,0,48,80v96a64.07,64.07,0,0,0,64,64h32a64.07,64.07,0,0,0,64-64V80A64.07,64.07,0,0,0,144,16Zm48,160a48.05,48.05,0,0,1-48,48H112a48.05,48.05,0,0,1-48-48V80a48.05,48.05,0,0,1,48-48h32a48.05,48.05,0,0,1,48,48ZM136,64v48a8,8,0,0,1-16,0V64a8,8,0,0,1,16,0Z"
);
const MOUSE_SIMPLE_FILL_PATH = new Path2D(
  "M144,16H112A64.07,64.07,0,0,0,48,80v96a64.07,64.07,0,0,0,64,64h32a64.07,64.07,0,0,0,64-64V80A64.07,64.07,0,0,0,144,16Zm-8,96a8,8,0,0,1-16,0V64a8,8,0,0,1,16,0Z"
);
const MOUSE_HOTSPOT = { x: 128, y: 128 }; // centered — a mouse body has no natural "tip"

const MOUSE_POINTER_ARROW_PATH = new Path2D(
  "M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"
);
const MOUSE_POINTER_TAIL_PATH = new Path2D("M12.586 12.586 19 19");
const MOUSE_POINTER_HOTSPOT = { x: 3.688, y: 3.037 }; // tip of the arrow

interface ClickRipple {
  startedAt: number; // currentMs (edited-timeline ms) at trigger
  x: number;
  y: number;
  r: number;
  style: CursorEditSettings["clickAnimationStyle"];
}

/** "#fff" / "#ffffff" → "rgba(r, g, b, alpha)"; falls back to the raw color on anything
 *  else (e.g. an already-valid CSS color) since hex is the only format the color picker
 *  and presets ever produce. */
function withAlpha(hexColor: string, alpha: number): string {
  const hex = hexColor.replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (full.length !== 6) return hexColor;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** One click sound's envelope, expressed against an arbitrary AudioContext/
 *  OfflineAudioContext and an arbitrary start time on that context's own clock — shared
 *  between the live preview's playClickSound (ctx.currentTime, real time) and export's
 *  offline render (an OfflineAudioContext's own virtual clock, driven by scheduled time
 *  rather than real time). Keeping the two in exact sync (same timbres, same envelopes)
 *  is the whole point of factoring this out, rather than the export render drifting out
 *  of sync with whatever the preview happens to sound like. */
function scheduleClickEnvelope(
  ctx: BaseAudioContext,
  dest: AudioNode,
  style: CursorEditSettings["clickSoundStyle"],
  at: number
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  if (style === "pop") {
    osc.type = "triangle";
    osc.frequency.setValueAtTime(900, at);
    osc.frequency.exponentialRampToValueAtTime(320, at + 0.09);
    gain.gain.setValueAtTime(0.22, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(at);
    osc.stop(at + 0.11);
  } else if (style === "click") {
    osc.type = "square";
    osc.frequency.setValueAtTime(2200, at);
    gain.gain.setValueAtTime(0.12, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(at);
    osc.stop(at + 0.035);
  } else {
    osc.type = "sine";
    osc.frequency.value = 1200;
    gain.gain.setValueAtTime(0.18, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(at);
    osc.stop(at + 0.07);
  }
}

/** Synthesizes a short click sound in one of a few timbres — no bundled audio asset
 *  needed for any of them. Live-preview-only: export renders its own click sounds
 *  separately and offline (see renderExportAudio), since this one is pinned to
 *  ctx.currentTime, a real-time clock incompatible with export's non-realtime render. */
function playClickSound(audioCtxRef: { current: AudioContext | null }, style: CursorEditSettings["clickSoundStyle"]): void {
  try {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    scheduleClickEnvelope(ctx, ctx.destination, style, ctx.currentTime);
  } catch {
    // Web Audio unavailable — skip the sound silently.
  }
}

/** Encodes a rendered AudioBuffer (from renderExportAudio's OfflineAudioContext) as a
 *  16-bit PCM WAV — no bundled encoder needed for a container this simple, and it's a
 *  format ffmpeg reads natively for the final mux (see editProjects.ts's export handler). */
function encodeWavPcm16(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = buffer.numberOfChannels;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return out;
}

/** Traces a rounded-rect as manual arc segments on the current path (caller does its own
 *  beginPath) — used instead of the native ctx.roundRect() everywhere a clip/stroke needs
 *  one, since roundRect's clip has proven unreliable for the large screen-content rect in
 *  this environment even though the small camera-bubble rect clipped fine with it. */
function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function bubbleDimensions(shape: CameraEditSettings["shape"], size: number): { width: number; height: number } {
  if (shape === "rectangle") return { width: size * RECT_ASPECT, height: size };
  if (shape === "rectangle-vertical") return { width: size, height: size * RECT_ASPECT };
  return { width: size, height: size };
}

/** Inverse of bubbleDimensions — recovers the pre-aspect "size" scalar from a dragged
 *  width/height, so a corner-resize can convert straight back into sizePct regardless
 *  of shape. */
function sizeFromBubbleDims(shape: CameraEditSettings["shape"], width: number, height: number): number {
  if (shape === "rectangle") return height;
  if (shape === "rectangle-vertical") return width;
  return Math.min(width, height);
}

/** Fills a rect with the Screen tab's backdrop (color/gradient/texture/image) — the base
 *  layer behind the (never-cropped) screen/camera content, so empty space reads as a
 *  deliberate design choice rather than dead black bars. */
function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  bg: BackgroundEditSettings,
  backdropImg: HTMLImageElement | null,
  w: number,
  h: number
): void {
  ctx.save();
  if (bg.fill !== "none" && bg.blurPct > 0) ctx.filter = `blur(${(bg.blurPct / 100) * MAX_BACKGROUND_BLUR_PX}px)`;
  if (bg.fill === "color") {
    ctx.fillStyle = bg.customColor ?? (BACKGROUND_COLORS.find((c) => c.id === bg.colorId) ?? BACKGROUND_COLORS[0]).color;
    ctx.fillRect(0, 0, w, h);
  } else if (bg.fill === "gradient") {
    const custom = bg.customGradient;
    const preset = custom ?? BACKGROUND_GRADIENTS.find((g) => g.id === bg.gradientId) ?? BACKGROUND_GRADIENTS[0];
    const angleDeg = custom ? 135 : (preset as BackgroundGradientPreset).angleDeg;
    const rad = (angleDeg * Math.PI) / 180;
    // CSS's linear-gradient() angle (0deg = "to top", clockwise) — matched here so the
    // canvas render lines up with the swatch preview, which is styled with the same
    // CSS gradient. Canvas's own angle convention (0 = east, standard math) is different
    // and was left in by mistake, rendering every gradient rotated ~90deg from its swatch.
    const dx = (Math.sin(rad) * w) / 2;
    const dy = (-Math.cos(rad) * h) / 2;
    const grad = ctx.createLinearGradient(w / 2 - dx, h / 2 - dy, w / 2 + dx, h / 2 + dy);
    grad.addColorStop(0, preset.from);
    grad.addColorStop(1, preset.to);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  } else if (bg.fill === "texture" || bg.fill === "image") {
    // Both fills are a curated (or, for "image", user-imported) photo drawn cover-fit —
    // which photo is loaded into `backdropImg` is resolved by the caller (see
    // PreviewCompositor's bgImageRef effect), keyed off textureId/imageId/customImagePath.
    if (backdropImg && backdropImg.naturalWidth) {
      const scale = Math.max(w / backdropImg.naturalWidth, h / backdropImg.naturalHeight);
      const dw = backdropImg.naturalWidth * scale;
      const dh = backdropImg.naturalHeight * scale;
      ctx.drawImage(backdropImg, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = FALLBACK_BACKGROUND;
      ctx.fillRect(0, 0, w, h);
    }
  } else {
    ctx.fillStyle = FALLBACK_BACKGROUND;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

interface BackdropCache {
  canvas: HTMLCanvasElement;
  key: string;
}

/** drawBackdrop's result, memoized into an offscreen canvas and blitted per frame.
 *
 *  The backdrop is static for the whole of an export (and for long stretches of live
 *  editing), but re-deriving it every frame was not free: with a background blur set,
 *  `ctx.filter = blur(...)` over a full 1920x1080 fill measured ~40ms per frame — on top
 *  of, and in the same main-thread budget as, the per-frame encode. Blitting a cached
 *  bitmap instead is ~1.7ms. Rendering into a same-sized offscreen canvas and drawing it
 *  1:1 keeps the output pixel-identical, blur's edge falloff at the canvas borders
 *  included.
 *
 *  The key covers everything drawBackdrop actually reads — the settings object plus the
 *  resolved backdrop image's identity and its decoded size, since the same `src` renders
 *  differently (or not at all) before it has loaded. */
function drawBackdropCached(
  ctx: CanvasRenderingContext2D,
  bg: BackgroundEditSettings,
  backdropImg: HTMLImageElement | null,
  w: number,
  h: number,
  cacheRef: React.MutableRefObject<BackdropCache | null>
): void {
  const key = `${JSON.stringify(bg)}|${backdropImg?.src ?? ""}|${backdropImg?.naturalWidth ?? 0}x${backdropImg?.naturalHeight ?? 0}|${w}x${h}`;
  let cache = cacheRef.current;
  if (!cache || cache.key !== key) {
    const off = cache?.canvas ?? document.createElement("canvas");
    if (off.width !== w || off.height !== h) {
      off.width = w;
      off.height = h;
    }
    const offCtx = off.getContext("2d");
    // No offscreen context available (vanishingly unlikely) — just draw straight to the
    // real canvas, exactly as this did before the cache existed.
    if (!offCtx) {
      drawBackdrop(ctx, bg, backdropImg, w, h);
      return;
    }
    offCtx.clearRect(0, 0, w, h);
    drawBackdrop(offCtx, bg, backdropImg, w, h);
    cache = { canvas: off, key };
    cacheRef.current = cache;
  }
  ctx.drawImage(cache.canvas, 0, 0);
}

/** The camera bubble's size for a given reference box — sizePct is always a % of that
 *  box's shorter dimension, whatever the box turns out to be (full canvas for "overlay",
 *  a reel half, a split strip, …). */
function cameraBubbleSize(cam: CameraEditSettings, referenceBox: { w: number; h: number }): { width: number; height: number } {
  const shorter = Math.min(referenceBox.w, referenceBox.h);
  return bubbleDimensions(cam.shape, (cam.sizePct / 100) * shorter);
}

/** Draws the camera as a shaped/sized bubble at an already-resolved origin. `zoomPct`
 *  crops into the center of the source feed before fitting it, the same crop-in idea as
 *  the Background tab's zoom. */
function drawCameraBubbleAt(
  ctx: CanvasRenderingContext2D,
  source: HTMLVideoElement,
  cam: CameraEditSettings,
  x: number,
  y: number,
  width: number,
  height: number
): void {
  const size = Math.min(width, height);
  const radius = cam.shape !== "round" ? (cam.cornerRadiusPct / 100) * (size / 2) : 0;

  ctx.save();
  ctx.beginPath();
  if (cam.shape === "round") {
    ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else {
    roundedRectPath(ctx, x, y, width, height, radius);
  }
  ctx.clip();

  const camW = source.videoWidth || 1;
  const camH = source.videoHeight || 1;
  const zoom = Math.max(1, cam.zoomPct / 100);
  const srcCropW = camW / zoom;
  const srcCropH = camH / zoom;
  const srcCropX = (camW - srcCropW) / 2;
  const srcCropY = (camH - srcCropH) / 2;
  const scale = Math.max(width / srcCropW, height / srcCropH);
  const drawW = srcCropW * scale;
  const drawH = srcCropH * scale;
  ctx.drawImage(
    source,
    srcCropX,
    srcCropY,
    srcCropW,
    srcCropH,
    x + (width - drawW) / 2,
    y + (height - drawH) / 2,
    drawW,
    drawH
  );
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, .85)";
  ctx.lineWidth = Math.max(1, Math.min(width, height) * 0.012);
  ctx.beginPath();
  if (cam.shape === "round") {
    ctx.ellipse(x + width / 2, y + height / 2, width / 2 - 1, height / 2 - 1, 0, 0, Math.PI * 2);
  } else {
    roundedRectPath(ctx, x + 1, y + 1, width - 2, height - 2, radius);
  }
  ctx.stroke();
  ctx.restore();
}

interface ScreenFit {
  screenDrawX: number;
  screenDrawY: number;
  fitScale: number;
  srcX: number;
  srcY: number;
  svW: number;
  svH: number;
}

interface ScreenContentFit {
  contentX: number;
  contentY: number;
  contentW: number;
  contentH: number;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
  fitW: number;
  fitH: number;
  fitScale: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** The padding/zoom/fit math shared between drawing the screen recording and (for reel's
 *  full-bleed "cover" mode) building the pan drag region below it — kept in one place so
 *  the two can never drift out of sync with each other. `focusSrc` (source-video pixel
 *  coords), while a timeline zoom block is active, is the point to zoom *toward* — not
 *  toward the frame's own center, but not recentered onto that point either: the crop is
 *  positioned so focusSrc keeps the same relative position within the frame it already
 *  had before zooming (bottom-right stays bottom-right, just magnified), the way zooming
 *  toward a cursor in an image viewer or map works, rather than the click jumping to the
 *  middle of the screen. Clamped so the crop window never runs off the source video's edge
 *  — which is also the only time that relative position doesn't hold exactly, since the
 *  crop can't follow it any further once it's already flush against that edge. */
function computeScreenContentFit(
  box: Rect,
  bg: BackgroundEditSettings,
  screenVideo: HTMLVideoElement,
  fitMode: "contain" | "cover",
  focusSrc?: { x: number; y: number } | null
): ScreenContentFit {
  const shorterBox = Math.min(box.w, box.h);
  const padding = (bg.paddingPct / 100) * shorterBox;
  const contentX = box.x + padding;
  const contentY = box.y + padding;
  const contentW = Math.max(1, box.w - padding * 2);
  const contentH = Math.max(1, box.h - padding * 2);

  const svW = screenVideo.videoWidth;
  const svH = screenVideo.videoHeight;
  // Per-side crop narrows the frame zoom/pan then operates within, applied first so the
  // two compose naturally — zooming still homes in on focusSrc's position within the
  // cropped frame exactly as it would the full one.
  const cropL = (bg.cropLeftPct / 100) * svW;
  const cropR = (bg.cropRightPct / 100) * svW;
  const cropT = (bg.cropTopPct / 100) * svH;
  const cropB = (bg.cropBottomPct / 100) * svH;
  const cropW = Math.max(1, svW - cropL - cropR);
  const cropH = Math.max(1, svH - cropT - cropB);
  const zoom = Math.max(1, bg.zoomPct / 100);
  const srcW = cropW / zoom;
  const srcH = cropH / zoom;
  // Keeps focusSrc at the same fractional position within the crop that it holds within
  // the cropped frame (relative to cropL/cropT), rather than forcing it to the crop's own
  // center (which is what a plain "centered crop" would do) — e.g. at 2x zoom the crop is
  // half-width, so a point 80% of the way across the cropped frame sits at
  // srcX + 0.8*srcW only when srcX = cropL + (focusSrc.x - cropL) * (1 - 1/zoom).
  const srcX = focusSrc
    ? cropL + clamp((focusSrc.x - cropL) * (1 - 1 / zoom), 0, Math.max(0, cropW - srcW))
    : cropL + (cropW - srcW) / 2;
  const srcY = focusSrc
    ? cropT + clamp((focusSrc.y - cropT) * (1 - 1 / zoom), 0, Math.max(0, cropH - srcH))
    : cropT + (cropH - srcH) / 2;
  const fitScale =
    fitMode === "cover" ? Math.max(contentW / srcW, contentH / srcH) : Math.min(contentW / srcW, contentH / srcH);
  const fitW = srcW * fitScale;
  const fitH = srcH * fitScale;

  return { contentX, contentY, contentW, contentH, srcX, srcY, srcW, srcH, fitW, fitH, fitScale };
}

/** Draws the screen recording (inset by padding, corners rounded) into an arbitrary box
 *  — the box itself is always a plain, freely drag/resizable rectangle (see draw()'s
 *  screenBox), independent of this function — and returns the fit metrics needed to map
 *  the recorded cursor track into the same space. `fitMode: "contain"` (the default,
 *  everywhere except reel's full-bleed) never crops — it letterboxes instead, centered,
 *  so an aspect mismatch between the recording and the box shows as backdrop on either
 *  side. `"cover"` instead crops to fill the box completely with no letterbox gap — used
 *  only when `reelScreenFull` is set, whose whole point is covering a portrait canvas
 *  edge to edge despite a typically-landscape recording. `panPct` just recenters which
 *  part of a "cover"-cropped recording shows; left at its default (centered) everywhere
 *  this is actually called from. `focusSrc` — see computeScreenContentFit — is the point
 *  a timeline zoom block zooms toward while active, keeping its own on-screen position
 *  instead of both the video's center *and* instead of recentering onto it. */
function drawScreenContent(
  ctx: CanvasRenderingContext2D,
  screenVideo: HTMLVideoElement,
  bg: BackgroundEditSettings,
  box: Rect,
  fitMode: "contain" | "cover" = "contain",
  panPct: { x: number; y: number } = { x: 50, y: 50 },
  // A deleted (non-rippled) stretch of the Clips track plays as a real gap — nothing
  // drawn, just the backdrop showing through — rather than freezing on whatever frame
  // screenVideo was paused on when the gap was entered.
  showFrame = true,
  focusSrc?: { x: number; y: number } | null
): ScreenFit {
  const m = computeScreenContentFit(box, bg, screenVideo, fitMode, focusSrc);
  const screenDrawX = m.contentX + (panPct.x / 100) * (m.contentW - m.fitW);
  const screenDrawY = m.contentY + (panPct.y / 100) * (m.contentH - m.fitH);

  if (showFrame && fitMode === "cover") {
    // The drawn image now overflows the content box on one axis by design — clip against
    // the box itself (not the oversized image rect) so that overflow is what gets cropped.
    const contentRadius = (bg.cornerRadiusPct / 100) * (Math.min(m.contentW, m.contentH) / 2);
    ctx.save();
    ctx.beginPath();
    roundedRectPath(ctx, m.contentX, m.contentY, m.contentW, m.contentH, contentRadius);
    ctx.clip();
    ctx.drawImage(screenVideo, m.srcX, m.srcY, m.srcW, m.srcH, screenDrawX, screenDrawY, m.fitW, m.fitH);
    ctx.restore();
  } else if (showFrame) {
    // Rounded against the video's own drawn rect, not the (possibly larger, aspect-
    // mismatched) padded content box — letterboxing means those rarely coincide, and a
    // corner rounded only where the box meets the padding is invisible against a backdrop
    // that fills both the letterbox gap and the padding with the same color.
    const contentRadius = (bg.cornerRadiusPct / 100) * (Math.min(m.fitW, m.fitH) / 2);
    ctx.save();
    ctx.beginPath();
    roundedRectPath(ctx, screenDrawX, screenDrawY, m.fitW, m.fitH, contentRadius);
    ctx.clip();
    ctx.drawImage(screenVideo, m.srcX, m.srcY, m.srcW, m.srcH, screenDrawX, screenDrawY, m.fitW, m.fitH);
    ctx.restore();
  }

  return {
    screenDrawX,
    screenDrawY,
    fitScale: m.fitScale,
    srcX: m.srcX,
    srcY: m.srcY,
    svW: screenVideo.videoWidth,
    svH: screenVideo.videoHeight,
  };
}

/** The zoom block (if any) whose window contains `currentMs` — later blocks in the array
 *  win on overlap, since they're the ones the user most recently placed there. */
function findActiveZoom(zooms: TimelineZoom[], currentMs: number): TimelineZoom | null {
  let found: TimelineZoom | null = null;
  for (const z of zooms) {
    if (currentMs >= z.startMs && currentMs <= z.startMs + z.durationMs) found = z;
  }
  return found;
}

/** 0 at either edge of an active zoom block's window (or when none is active), ramping up
 *  to 1 once fully past the ease-in (ZOOM_TRANSITION_MS) and staying there until the
 *  ease-out begins — the trapezoid computeActiveZoomPct eases `pct` through below. Exposed
 *  separately so the cursor-follow crop (see zoomFocusRef's own draw-loop usage) can tell
 *  "fully zoomed in, holding" (1) from "still changing scale" (<1) and freeze its pan
 *  during the latter — panning *while* the scale itself is changing reads as two motions
 *  fighting each other instead of one clean zoom. */
function computeZoomEnvelope(zoom: TimelineZoom | null, currentMs: number): number {
  if (!zoom) return 0;
  const half = Math.max(1, zoom.durationMs / 2);
  const transition = Math.min(ZOOM_TRANSITION_MS, half);
  const tIn = Math.min(1, (currentMs - zoom.startMs) / transition);
  const tOut = Math.min(1, (zoom.startMs + zoom.durationMs - currentMs) / transition);
  return Math.max(0, Math.min(tIn, tOut));
}

/** Eases from `baselinePct` up to the active zoom block's pct and back down over
 *  ZOOM_TRANSITION_MS at each edge of its window, holding at the target in between —
 *  a trapezoid envelope, not a hard cut in zoom level. */
function computeActiveZoomPct(baselinePct: number, zoom: TimelineZoom | null, envelope: number): number {
  if (!zoom) return baselinePct;
  const eased = (1 - Math.cos(envelope * Math.PI)) / 2;
  return baselinePct + (zoom.pct - baselinePct) * eased;
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export const PreviewCompositor = forwardRef<PreviewCompositorHandle, PreviewCompositorProps>(function PreviewCompositor(
  {
    screenFilePath,
    cameraFilePath,
    audioFilePath,
    sideClipStartOffsetMs,
    cursorMetadataPath,
    cursorIconsDir,
    cursorBakedIn,
    camera,
    onCameraChange,
    background,
    cursor,
    layout,
    onLayoutChange,
    sound,
    onSoundChange,
    timeline,
    onTimelineChange,
    tool,
    onTimeUpdate,
    onUndo,
    onRedo,
    canUndo,
    canRedo,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  // cameraVideoRef.current.duration itself is unusable for sizing the camera track's
  // default clip: a MediaRecorder-produced webm reports `duration: Infinity` until the
  // browser has actually parsed all the way to the end of the file (see mediaProtocol.ts's
  // own note on this exact quirk) — Number.isFinite(cameraVideo.duration) is false almost
  // always in practice, not just as a rare edge case. Populated once by the video-loading
  // effect below via the seek-past-the-end trick that forces that parse; null until then
  // (during which callers fall back to the screen recording's own duration, same as before
  // this existed).
  const cameraDurationMsRef = useRef<number | null>(null);
  // The actual recorded audio (mic/system, talking, etc.) whenever it doesn't just live
  // directly on screenVideo itself — a separate camera track's own file, or a screen-only
  // recording's own separately-captured audio.wav (see audioFilePath's own doc comment).
  // Never drawn from, only ever played, so a plain <audio> element rather than a second
  // hidden <video> — and deliberately decoupled from cameraVideoRef's own play/pause (see
  // its doc comment), so hiding/deleting a Camera piece never silences this. Kept in sync
  // with screenVideo's own position/play-state by the live draw loop (see its own
  // comment), never the Camera track's, since it has no independent clip list of its own.
  const audioOnlyRef = useRef<HTMLAudioElement | null>(null);
  const blurVideoRef = useRef<HTMLVideoElement | null>(null);
  const blurHandleRef = useRef<CameraBlurHandle | null>(null);
  const rafRef = useRef(0);
  const rippleRef = useRef<ClickRipple | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  // True only while exportVideo()'s frame-stepped capture is in flight. draw() checks
  // this for two things: (1) to skip the editing-only affordances (drag outline/resize
  // handles, snap guides) it otherwise renders every frame, so they don't get baked into
  // the recorded pixels; (2) to trust currentMs/activeClipIdRef/activeCameraClipIdRef as
  // already resolved by the export loop's own seekToEditedMs call for this exact frame,
  // instead of deriving them itself from screenVideo.currentTime/wall-clock — export
  // steps through the timeline out of real time, so neither of those live signals means
  // anything during a capture. Also silences the live click-sound synth (see its call
  // site below) — export's audio is rendered separately, offline (see renderExportAudio).
  const isExportingRef = useRef(false);
  // Set by the draw-loop effect below to that effect's own `draw` closure, so exportVideo
  // (a different function in this component, with no access to that closure otherwise)
  // can invoke exactly one frame's worth of rendering itself, once per output frame,
  // instead of relying on the always-on rAF loop that drives it for live preview.
  const drawFrameRef = useRef<(() => void) | null>(null);
  const lastPlaybackMsRef = useRef(-1);
  // Id of whichever clip is currently "active" — either the raw video is actively playing
  // through it (tracked off screenVideo.currentTime), or, if null, we're in a gap (a
  // stretch no clip covers) and `editedMsRef` is what's advancing instead.
  const activeClipIdRef = useRef<string | null>(null);
  // Id of whichever Camera piece currently covers the edited-timeline playhead, resolved
  // independently against the *same* `currentMs` the screen clip above derives (it's the
  // master clock) — the Camera track drags/trims freely, same as Clips, so its own source
  // position generally isn't `currentMs`'s screen-relative one. Null while no piece covers
  // the playhead, which is what hides the camera bubble for that stretch.
  const activeCameraClipIdRef = useRef<string | null>(null);
  // The authoritative playhead position on the edited timeline while in a gap — advanced
  // by wall-clock time each frame (there's no video position to read there). Ignored
  // while activeClipIdRef is set; a real clip derives its own editedMs off the video.
  const editedMsRef = useRef(0);
  // performance.now() as of the previous draw() call — the wall-clock delta between
  // frames is how a gap's position advances.
  const lastFrameAtRef = useRef(performance.now());
  // Where an active zoom block's crop is centered (source-video pixel coords) — captured
  // once, the moment the block becomes active, and held completely fixed for its entire
  // window (ease-in, hold, *and* ease-out alike). Deliberately not a live cursor-follow —
  // see the draw loop's own zoom section for why. Cleared whenever no zoom is active so the
  // next one starts fresh instead of carrying over the last one's position.
  const zoomFocusRef = useRef<{ x: number; y: number } | null>(null);
  // Which zoom block zoomFocusRef was last seeded for — lets the draw loop tell "just
  // entered a new zoom block" (seed the fixed focus once, from the cursor's position right
  // now) from "still inside the same block" (leave it alone, holding steady for the rest of
  // that block's window).
  const activeZoomIdRef = useRef<string | null>(null);
  // The user's actual play/pause intent — distinct from screenVideo.paused, which the
  // draw loop itself toggles while passing through a gap.
  const isPlayingRef = useRef(false);

  // Drag-to-position/resize — the screen and camera can always be moved (dragging the
  // body) and resized (dragging any of its 4 corner handles) directly on the canvas,
  // whichever format is active. Populated fresh each draw() frame with that frame's resolved geometry,
  // so pointer handlers (registered once) always hit-test against up-to-date rects
  // without needing draw() in their deps.
  const interactionRef = useRef<{
    screenRect: Rect;
    cameraRect: Rect | null;
    screenDrag: DragRegion | null;
    cameraDrag: DragRegion | null;
    screenResizeHandles: Record<Corner, Rect>;
    cameraResizeHandles: Record<Corner, Rect> | null;
    canvasW: number;
    canvasH: number;
  }>({
    screenRect: { x: 0, y: 0, w: 0, h: 0 },
    cameraRect: null,
    screenDrag: null,
    cameraDrag: null,
    screenResizeHandles: cornerHandles({ x: 0, y: 0, w: 0, h: 0 }, 0),
    cameraResizeHandles: null,
    canvasW: 0,
    canvasH: 0,
  });
  const dragStateRef = useRef<
    | {
        mode: "move";
        target: "screen" | "camera";
        region: DragRegion;
        grabDX: number;
        grabDY: number;
        startClientX: number;
        startClientY: number;
        // Set only when this move grabbed the screen mid-split-derivation (see
        // handlePointerDown) — the size it's handing control over at, carried through the
        // drag itself rather than relying on a separate state update to have round-tripped
        // back through layoutRef before the next move event reads it (that race is exactly
        // what let a stale, still-100%-full-canvas ref value re-overwrite it moment the
        // move handler below spreads {...layoutRef.current, freeScreenPos}).
        capturedSize?: { freeScreenSizePct: number; freeScreenHeightPct: number };
      }
    // anchorX/Y is the *opposite* corner from the one grabbed — it's what stays fixed
    // while the grabbed corner (and the box's opposite edges) follow the pointer.
    | { mode: "resize"; target: "screen" | "camera"; corner: Corner; anchorX: number; anchorY: number; startClientX: number; startClientY: number }
    // Screen-only, while reelScreenFull: dragging pans which part of the (necessarily
    // cropped, to cover with no letterbox gap) recording is visible, instead of moving
    // the box — a full-bleed box has no on-canvas position worth dragging, and sliding it
    // like a normal box would just expose blank background on the side it moved away
    // from rather than reveal the part of the video that's actually hidden there.
    | { mode: "pan"; grabDX: number; grabDY: number; startClientX: number; startClientY: number }
    | null
  >(null);
  const guideRef = useRef<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const didDragRef = useRef(false); // set once a drag actually moves — suppresses the click-to-play that follows pointerup
  const onLayoutChangeRef = useRef(onLayoutChange);
  useEffect(() => {
    onLayoutChangeRef.current = onLayoutChange;
  }, [onLayoutChange]);
  const onCameraChangeRef = useRef(onCameraChange);
  useEffect(() => {
    onCameraChangeRef.current = onCameraChange;
  }, [onCameraChange]);

  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const onTimelineChangeRef = useRef(onTimelineChange);
  useEffect(() => {
    onTimelineChangeRef.current = onTimelineChange;
  }, [onTimelineChange]);
  // The canvas's current pixel aspect (reel, or overlay/split's shared 16:9) — mirrored into state
  // (updated only when it actually changes) so the CSS frame around it can be sized to
  // match via `aspect-ratio`, instead of stretching to the panel's own box and leaving the
  // border to sit way outside a letterboxed/pillarboxed render.
  const [canvasSize, setCanvasSize] = useState({ w: 16, h: 9 });
  const canvasSizeRef = useRef(canvasSize);

  const cameraRef = useRef(camera);
  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  const backgroundRef = useRef(background);
  useEffect(() => {
    backgroundRef.current = background;
  }, [background]);

  // Whichever photo the current backdrop fill needs — a curated texture, a curated
  // image, or the user's own imported one — loaded here so drawBackdrop (which only
  // touches the canvas, no network/asset resolution of its own) can just drawImage() it.
  const backdropImageUrl =
    background.fill === "texture"
      ? (BACKGROUND_TEXTURE_URLS[background.textureId] ?? null)
      : background.fill === "image"
        ? background.customImagePath
          ? mediaUrl(background.customImagePath)
          : (BACKGROUND_IMAGE_URLS[background.imageId] ?? null)
        : null;

  const bgImageRef = useRef<HTMLImageElement | null>(null);
  // Memoized backdrop bitmap — see drawBackdropCached.
  const backdropCacheRef = useRef<BackdropCache | null>(null);
  useEffect(() => {
    bgImageRef.current = null;
    if (!backdropImageUrl) return;
    const img = new Image();
    // Needed for the media:// (custom-image backdrop) case — see screenVideo's own
    // crossOrigin comment below for why. A no-op for the bundled texture/preset URLs,
    // which are same-origin either way.
    img.crossOrigin = "anonymous";
    img.onload = () => {
      bgImageRef.current = img;
    };
    img.src = backdropImageUrl;
  }, [backdropImageUrl]);

  const cursorRef = useRef(cursor);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  const cursorBakedInRef = useRef(!!cursorBakedIn);
  useEffect(() => {
    cursorBakedInRef.current = !!cursorBakedIn;
    console.log("[PreviewCompositor] cursorBakedIn prop", { cursorBakedIn, screenFilePath });
  }, [cursorBakedIn, screenFilePath]);

  // How far into screenFilePath's own timeline the Camera track's source file (and the
  // audio-only element, when there's no camera) actually starts — see this prop's own doc
  // comment. Read from the draw loop/export via a ref, same pattern as cursorBakedInRef,
  // rather than a dependency, since it's static for a given project and shouldn't force
  // those closures to be rebuilt.
  const sideClipOffsetMsRef = useRef(sideClipStartOffsetMs ?? 0);
  useEffect(() => {
    sideClipOffsetMsRef.current = sideClipStartOffsetMs ?? 0;
  }, [sideClipStartOffsetMs]);

  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  const timelineRef = useRef(timeline);
  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);

  const onTimeUpdateRef = useRef(onTimeUpdate);
  useEffect(() => {
    onTimeUpdateRef.current = onTimeUpdate;
  }, [onTimeUpdate]);

  const cursorTrackRef = useRef<{ metadata: CursorMetadata; icons: LoadedCursorIcon[] } | null>(null);
  useEffect(() => {
    let cancelled = false;
    cursorTrackRef.current = null;
    lastPlaybackMsRef.current = -1;
    rippleRef.current = null;
    if (!cursorMetadataPath || !cursorIconsDir) return;
    (async () => {
      try {
        const metadata: CursorMetadata = await (await fetch(mediaUrl(cursorMetadataPath))).json();
        const icons = await Promise.all(
          metadata.icons.map(
            (asset) =>
              new Promise<LoadedCursorIcon>((resolve, reject) => {
                const img = new Image();
                // See screenVideo's crossOrigin comment below — media:// is a different
                // origin from the page, so without this, drawing this icon onto the export
                // canvas would taint it even though on-screen preview draws fine either way.
                img.crossOrigin = "anonymous";
                img.onload = () =>
                  resolve({ img, width: asset.width, height: asset.height, hotspotX: asset.hotspotX, hotspotY: asset.hotspotY });
                img.onerror = () => reject(new Error(`failed to load cursor icon ${asset.file}`));
                img.src = mediaUrl(`${cursorIconsDir}/${asset.file}`);
              })
          )
        );
        if (!cancelled) cursorTrackRef.current = { metadata, icons };
      } catch {
        // No cursor track for this recording — preview just won't show a synthetic cursor.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cursorMetadataPath, cursorIconsDir]);

  // Recorded audio can come from *both* elements at once now, so muting has to reach both.
  // screenVideoRef carries the system audio ("system sound"), which lives in the screen
  // track on every platform — written there natively by macOS's ScreenCaptureKit capture,
  // muxed in at save time from Chromium's desktop loopback on Windows/Linux (see
  // ipc/recording.ts's resolveScreenTrack) — as well as being the whole soundtrack on its
  // own for an already-muxed single file. audioOnlyRef carries the mic, from the camera
  // side clip or a screen-only recording's audio.wav. Either can be absent: a project
  // recorded with system sound off has a silent screen track, one with no mic has no
  // audioOnly element, and anything recorded before this split has both sources mixed
  // together in the side clip with a silent screen track. Never cameraVideoRef — see its
  // own doc comment for why that element is muted and visual-only.
  const mutedRef = useRef(sound.muted);
  useEffect(() => {
    mutedRef.current = sound.muted;
    for (const el of [audioOnlyRef.current, screenVideoRef.current]) {
      if (el) el.muted = sound.muted;
    }
  }, [sound.muted]);

  // Load the source video(s) whenever the project's media changes.
  useEffect(() => {
    const screenVideo = document.createElement("video");
    // media:// (mediaProtocol.ts) is always a different origin from the renderer page
    // (file:// in production, http://localhost in dev) — without this, the browser fetches
    // the video in no-cors mode, which taints the canvas the instant it's drawn regardless
    // of the response's own CORS headers (see mediaProtocol.ts's Access-Control-Allow-Origin
    // comment). Playback itself doesn't need this — only pixel reads like exportVideo's
    // canvas.toBlob() do, which is why this only ever surfaced as a "Tainted canvases may
    // not be exported" export-time failure, never a playback issue.
    screenVideo.crossOrigin = "anonymous";
    screenVideo.src = mediaUrl(screenFilePath);
    // Not force-muted when there's a side clip any more: the screen track is where system
    // audio lives now (see mutedRef's own comment), so silencing it here would drop system
    // sound from every recording that also has a mic. Harmless for the projects that don't
    // have any — an unmuted video with no audio track is silent either way.
    screenVideo.muted = mutedRef.current;
    screenVideo.playsInline = true;
    screenVideoRef.current = screenVideo;

    let cameraVideo: HTMLVideoElement | null = null;
    cameraDurationMsRef.current = null;
    function resolveCameraDuration() {
      if (!cameraVideo) return;
      if (Number.isFinite(cameraVideo.duration)) {
        cameraDurationMsRef.current = cameraVideo.duration * 1000;
        return;
      }
      // Forcing a seek past the true end makes Chromium parse the whole file and correct
      // `duration` via a 'durationchange' event — see cameraDurationMsRef's own comment.
      // Seeking back to 0 after leaves the element exactly where it started for whatever
      // loads/plays it next.
      const onDurationChange = () => {
        if (!cameraVideo || !Number.isFinite(cameraVideo.duration)) return;
        cameraVideo.removeEventListener("durationchange", onDurationChange);
        cameraDurationMsRef.current = cameraVideo.duration * 1000;
        cameraVideo.currentTime = 0;
      };
      cameraVideo.addEventListener("durationchange", onDurationChange);
      cameraVideo.currentTime = 1e9;
    }
    if (cameraFilePath) {
      cameraVideo = document.createElement("video");
      // See screenVideo's crossOrigin comment above.
      cameraVideo.crossOrigin = "anonymous";
      cameraVideo.src = mediaUrl(cameraFilePath);
      // Always muted — visual-only now. Its audio (mic/system) is carried by audioOnly
      // below instead, decoupled from this element's own play/pause, which is driven by
      // the Camera track's own clips (see this effect's draw-loop counterpart) purely to
      // control when/where the camera bubble is shown. Coupling the two used to mean
      // deleting or trimming a Camera piece silenced that stretch of audio too, even
      // though the user was only ever editing the bubble's visibility, never the sound.
      cameraVideo.muted = true;
      cameraVideo.playsInline = true;
      cameraVideoRef.current = cameraVideo;
      if (cameraVideo.readyState >= 1) resolveCameraDuration();
      else cameraVideo.addEventListener("loadedmetadata", resolveCameraDuration, { once: true });
    }

    // The actual audio source whenever it doesn't just live directly on screenVideo
    // itself: the camera file (if there's a separate camera track — see cameraVideo's own
    // doc comment for why that element no longer carries its own audio), else a
    // screen-only recording's own separately-captured audio.wav, if there is one (see
    // EditProjectMedia.audioFilePath). Always synced to *screenVideo's* position/play-
    // state, never the Camera track's (see the draw loop's own sync block) — audio should
    // track the master (screen) timeline's cuts, not the independently-editable camera
    // bubble's visibility.
    let audioOnly: HTMLAudioElement | null = null;
    const audioSourcePath = cameraFilePath ?? audioFilePath;
    if (audioSourcePath) {
      audioOnly = new Audio();
      audioOnly.src = mediaUrl(audioSourcePath);
      audioOnly.muted = mutedRef.current;
      audioOnlyRef.current = audioOnly;
    }

    // progress/duration (the preview's own scrub bar, in seconds/fraction) are set from
    // inside the draw loop below instead of "timeupdate" — the loop already resolves
    // edited-timeline position every frame via the clips sequence, and that's what the
    // scrub bar needs to reflect, not screenVideo's own raw source-time progress.
    function onEnded() {
      // isPlayingRef, not just the `playing` state — otherwise the draw loop (which reads
      // the ref, not the state) still believes playback is active after screenVideo hits
      // the *raw source's* natural end, and keeps trying to advance/resolve clips as if
      // still playing.
      isPlayingRef.current = false;
      setPlaying(false);
    }
    screenVideo.addEventListener("ended", onEnded);

    return () => {
      // pause() alone leaves the element's in-flight `media://` request (an open file
      // handle on the main-process side, see mediaProtocol.ts) alive — these elements are
      // never inserted into the DOM, so nothing forces Chromium to abort that request
      // until GC eventually collects the element, on its own unpredictable schedule.
      // Clearing `src` (then `load()`, which is what actually makes the clear take effect)
      // aborts it immediately instead, so navigating away from a project promptly releases
      // its files — otherwise a delete landing in that gap can fail with EBUSY on Windows.
      screenVideo.pause();
      screenVideo.removeAttribute("src");
      screenVideo.load();
      cameraVideo?.pause();
      cameraVideo?.removeAttribute("src");
      cameraVideo?.load();
      audioOnly?.pause();
      audioOnly?.removeAttribute("src");
      audioOnly?.load();
      screenVideo.removeEventListener("ended", onEnded);
      screenVideoRef.current = null;
      cameraVideoRef.current = null;
      cameraDurationMsRef.current = null;
      audioOnlyRef.current = null;
      setPlaying(false);
      setProgress(0);
      setDuration(0);
    };
  }, [screenFilePath, cameraFilePath, audioFilePath]);

  // Background blur — rebuild the blurred camera output whenever the level changes.
  useEffect(() => {
    blurHandleRef.current?.stop();
    blurHandleRef.current = null;
    blurVideoRef.current = null;
    const cameraVideo = cameraVideoRef.current;
    if (!cameraVideo || camera.blur === "none") return;
    const captureable = cameraVideo as HTMLVideoElement & { captureStream?: () => MediaStream };
    if (!captureable.captureStream) return;
    const handle = applyCameraBlur(captureable.captureStream(), camera.blur);
    const outVideo = document.createElement("video");
    outVideo.muted = true;
    outVideo.playsInline = true;
    outVideo.srcObject = handle.stream;
    outVideo.play().catch(() => {});
    blurHandleRef.current = handle;
    blurVideoRef.current = outVideo;
    return () => {
      handle.stop();
    };
  }, [camera.blur, cameraFilePath]);

  // Draw loop — background fill, screen content (padded/rounded), camera bubble on top.
  useEffect(() => {
    function draw() {
      // While exporting, exportVideo calls this closure directly (via drawFrameRef) once
      // per output frame, at its own pace — the ambient rAF loop stands down for the
      // duration (resumed by exportVideo's own finally block once it's done) so the two
      // never both drive a frame at once.
      if (!isExportingRef.current) rafRef.current = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const screenVideo = screenVideoRef.current;
      if (!canvas || !screenVideo || !screenVideo.videoWidth) return;

      const layoutSettings = layoutRef.current;
      const cam = cameraRef.current;
      const bg = backgroundRef.current;
      const cameraSource = blurVideoRef.current ?? cameraVideoRef.current;
      const hasCameraSource = !!cameraSource && !!cameraSource.videoWidth;

      let canvasW: number;
      let canvasH: number;
      if (layoutSettings.format === "reel") {
        canvasW = STACK_CANVAS_WIDTH;
        canvasH = STACK_CANVAS_HEIGHT;
      } else {
        // "landscape" — fixed 16:9 wide canvas, whichever landscapeMode.
        canvasW = WIDE_CANVAS_WIDTH;
        canvasH = WIDE_CANVAS_HEIGHT;
      }
      if (canvasSizeRef.current.w !== canvasW || canvasSizeRef.current.h !== canvasH) {
        canvasSizeRef.current = { w: canvasW, h: canvasH };
        setCanvasSize({ w: canvasW, h: canvasH });
      }
      if (canvas.width !== canvasW || canvas.height !== canvasH) {
        canvas.width = canvasW;
        canvas.height = canvasH;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      drawBackdropCached(ctx, bg, bgImageRef.current, canvas.width, canvas.height, backdropCacheRef);

      // Clips — each has its own independent timelineStart and can freely overlap another
      // (the last one in the array wins wherever they overlap); a stretch nothing covers
      // is a gap, which plays as real, silent background rather than being skipped —
      // tracked by wall-clock time since there's no video position to read there. A clip
      // actually playing is tracked the usual way, off screenVideo's own currentTime,
      // handing off to whatever (if anything) covers the moment right after it ends.
      // `currentMs` below — and therefore zoom/Camera-clip lookups — is edited time, not
      // raw source time, so those travel with the edited output, not with moved footage.
      const timelineState = timelineRef.current;
      const sourceDurationMs = (screenVideo.duration || 0) * 1000;
      // Sized off the camera file's own duration, not the screen recording's — the two are
      // separately captured and frequently differ by a couple of seconds (camera
      // capture starting/stopping slightly off from screen capture), so an unedited
      // camera clip stretched to match the screen's length claims content that doesn't
      // exist in the camera file at all. Live playback just freezes on the camera's last
      // real frame once currentTime clamps at its own duration, which is easy to miss —
      // export's frame-exact waitUntilSourceTime has no such clamp to fall back on and
      // instead stalls on every single frame in that stretch waiting for an unreachable
      // position, which is what actually surfaced this (see waitUntilSourceTime's own
      // stall-timeout comment).
      const cameraSourceDurationMs = cameraDurationMsRef.current ?? sourceDurationMs;
      // Both tracks' default (unedited) pieces share one edited length and both start at
      // edited 0 — the shorter of "how much screen content is left once its own
      // camera-less lead-in (sideClipOffsetMsRef) is trimmed off the front" and "how much
      // camera content actually exists." Clips trims that lead-in off its own sourceStart
      // (real footage, still recoverable via the trim handle — see effectiveClips' own doc
      // comment); Camera no longer needs to start later to line up, since Clips now starts
      // later in *source* terms instead.
      const offsetMs = sideClipOffsetMsRef.current;
      const alignedLengthMs = Math.min(Math.max(0, sourceDurationMs - offsetMs), cameraSourceDurationMs);
      const clips = effectiveClips(timelineState.clips, sourceDurationMs, 0, alignedLengthMs, offsetMs);
      // Computed up front (rather than down where the Camera track is otherwise resolved
      // below) so its own rightmost edge can extend `totalMs` — a Camera piece dragged/
      // trimmed past the end of the Clips track should grow the overall timeline to fit it,
      // not get silently clipped off the end.
      const cameraClips = effectiveClips(timelineState.cameraClips, cameraSourceDurationMs, 0, alignedLengthMs);
      let currentMs = 0;
      let totalMs = totalClipsExtentMs(cameraClips);
      let showScreenContent = false;
      const now = performance.now();
      const dtMs = Math.max(0, now - lastFrameAtRef.current);
      lastFrameAtRef.current = now;

      if (isExportingRef.current) {
        // Frame-stepped export already resolved this exact frame via seekToEditedMs
        // (see exportVideo) before calling draw() — editedMsRef.current and both video
        // elements' currentTime are already precisely where they need to be. Deriving
        // currentMs from screenVideo.currentTime (like the live branch below) or
        // advancing a gap by wall-clock dt would both be meaningless here: export runs
        // out of real time, as fast as seeking/drawing allows, not at 1x.
        totalMs = Math.max(totalMs, totalClipsExtentMs(clips));
        currentMs = editedMsRef.current;
        const resolved = resolveClipAt(clips, currentMs);
        activeClipIdRef.current = resolved ? resolved.clip.id : null;
        showScreenContent = !!resolved;
      } else if (clips.length > 0) {
        totalMs = Math.max(totalMs, totalClipsExtentMs(clips));
        let activeClip: TimelineClip | undefined = activeClipIdRef.current
          ? clips.find((c) => c.id === activeClipIdRef.current)
          : undefined;

        if (activeClip) {
          const sourceMsNow = screenVideo.currentTime * 1000;
          const clipDur = activeClip.sourceEnd - activeClip.sourceStart;
          if (sourceMsNow >= activeClip.sourceEnd - 1) {
            // Ran out of footage — resolve whatever covers the instant right after. If
            // that's a real gap, editedMsRef/currentMs land exactly on the boundary here;
            // the gap's own wall-clock advancement (below) picks it up next frame, rather
            // than also advancing it a second time within this same frame.
            const boundaryEditedMs = activeClip.timelineStart + clipDur;
            const next = resolveClipAt(clips, boundaryEditedMs);
            if (next) {
              activeClip = next.clip;
              screenVideo.currentTime = next.sourceMs / 1000;
              if (isPlayingRef.current) screenVideo.play().catch(() => {});
            } else {
              activeClip = undefined;
              screenVideo.pause();
            }
            editedMsRef.current = boundaryEditedMs;
            currentMs = boundaryEditedMs;
          } else {
            currentMs = activeClip.timelineStart + Math.max(0, sourceMsNow - activeClip.sourceStart);
          }
        } else {
          // In a gap — advance by wall-clock time and check whether something now covers it.
          editedMsRef.current = Math.min(totalMs, editedMsRef.current + (isPlayingRef.current ? dtMs : 0));
          const found = resolveClipAt(clips, editedMsRef.current);
          if (found) {
            activeClip = found.clip;
            screenVideo.currentTime = found.sourceMs / 1000;
            if (isPlayingRef.current) screenVideo.play().catch(() => {});
          } else if (isPlayingRef.current && editedMsRef.current >= totalMs) {
            isPlayingRef.current = false;
            setPlaying(false);
          }
          currentMs = editedMsRef.current;
        }

        activeClipIdRef.current = activeClip ? activeClip.id : null;
        showScreenContent = !!activeClip;
      }
      // Skipped during export — exportVideo tracks its own progress directly off the
      // output frame index, and firing these on every one of what can be thousands of
      // frames (each a separate microtask, so React can't batch them the way it does
      // rAF-paced live updates) would just add rendering overhead for state nothing is
      // reading right now, since the export dialog covers this component's own UI anyway.
      if (!isExportingRef.current) {
        onTimeUpdateRef.current?.(currentMs, totalMs, sourceDurationMs);
        setDuration(totalMs / 1000);
        setProgress(totalMs > 0 ? currentMs / totalMs : 0);

        // Mirrors the resolved edited-timeline position/play-state onto the audio-only
        // track — deliberately *not* screenVideo's own currentTime/paused, which pause at
        // every gap in the screen Clips track (blank background, no clip to play); audio
        // has no clip list of its own (see audioOnlyRef's own doc comment on why it isn't
        // subject to either track's cuts) and should keep playing straight through such a
        // gap exactly like it does through a hidden/deleted Camera piece. `currentMs`
        // above already advances at real time whether it's currently sourced from a
        // playing clip or a gap's own wall-clock stepping, so it's already the right clock
        // for this regardless of which. A frame or two of lag (the sync tolerance below)
        // is imperceptible; only live preview needs this at all — export's audio always
        // comes from a wholly separate offline render (see renderExportAudio), never from
        // this element's live playback.
        const audioOnly = audioOnlyRef.current;
        if (audioOnly) {
          // audioOnly's own t=0 falls sideClipOffsetMsRef.current ms into currentMs's
          // clock (see this ref's own doc comment) — before that point there's no audio to
          // play yet, so pause rather than clamp to 0 and play whatever's actually first.
          const offsetMs = sideClipOffsetMsRef.current;
          if (currentMs < offsetMs) {
            if (!audioOnly.paused) audioOnly.pause();
          } else {
            const audioTargetSec = (currentMs - offsetMs) / 1000;
            if (Math.abs(audioOnly.currentTime - audioTargetSec) > 0.15) audioOnly.currentTime = audioTargetSec;
            if (!isPlayingRef.current && !audioOnly.paused) audioOnly.pause();
            else if (isPlayingRef.current && audioOnly.paused) audioOnly.play().catch(() => {});
          }
        }
      }

      // Camera — resolved independently against the same edited-timeline `currentMs`
      // (the screen/Clips resolution above is the master clock). Its own pieces drag,
      // trim, and overlap freely, exactly like Clips (see TimelineClip), so the camera's
      // source position generally isn't the screen's — only forced back in sync at a
      // piece boundary/gap crossing, same drift-tolerant approach as the screen clip
      // above, so the camera's own audio doesn't stutter from a re-seek every frame.
      const cameraVideo = cameraVideoRef.current;
      const cameraResolved = resolveClipAt(cameraClips, currentMs);
      if ((cameraResolved?.clip.id ?? null) !== activeCameraClipIdRef.current && cameraVideo) {
        if (cameraResolved) {
          cameraVideo.currentTime = cameraResolved.sourceMs / 1000;
          if (isPlayingRef.current) cameraVideo.play().catch(() => {});
        } else {
          cameraVideo.pause();
        }
      }
      activeCameraClipIdRef.current = cameraResolved ? cameraResolved.clip.id : null;
      const showCameraTrackContent = !!cameraResolved;

      // Zoom — a timeline zoom block temporarily overrides the Background tab's static
      // zoomPct with an eased-in/out target for the duration of its window.
      const activeZoom = findActiveZoom(timelineState.zooms, currentMs);
      const zoomEnvelope = computeZoomEnvelope(activeZoom, currentMs);
      const zoomedBg: BackgroundEditSettings = { ...bg, zoomPct: computeActiveZoomPct(bg.zoomPct, activeZoom, zoomEnvelope) };

      // Sample the recorded cursor track early (before the crop is computed below) so an
      // active zoom block can center its crop on the cursor's actual position instead of
      // the screen's static center — "zoom into where the action is," not just "zoom into
      // the middle." Hoisted out here (rather than sampled again down in the cursor-draw
      // step) so both share one binary search per frame. `cursorTMs` is source time, and
      // the track's own `t` values are written on exactly that clock — ms from the screen
      // recording's first captured frame, with paused spans excluded, resolved at save time
      // by the capture clock in electron/main/native/screenCapture.ts — so the two are
      // directly comparable here with no offset to correct for.
      const track = cursorTrackRef.current;
      const cursorTMs = screenVideo.currentTime * 1000;
      // `pos` is null when the cursor hasn't moved recently (see `visible` below) — `point`
      // itself is still kept (unconditionally, whenever the track has any points at all) so
      // the click-detection bookkeeping further down stays driven by the same lookup even
      // while nothing is drawn.
      let cursorSample: { point: CursorMetadata["points"][number]; pos: { x: number; y: number } | null } | null = null;
      if (track && track.metadata.points.length > 0) {
        const points = track.metadata.points;
        let lo = 0;
        let hi = points.length - 1;
        let idx = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (points[mid].t <= cursorTMs) {
            idx = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        const point = points[idx];
        const visible = points.length === 1 || point.t <= cursorTMs + 1000;
        const pos = visible ? toFrameCoords(track.metadata, point.x, point.y) : null;
        cursorSample = { point, pos };
      }

      // Raw cursor position, in source-video pixel space, to zoom-focus on — captured once,
      // the moment this zoom block first becomes active, and held completely fixed for its
      // entire window (ease-in, hold, *and* ease-out alike). This is deliberately not a
      // live cursor-follow: a zoom block targets "where the click happened," not "wherever
      // the mouse currently is" — re-targeting every frame as the cursor kept moving during
      // the hold was panning the crop left/right on its own, on top of the zoom itself,
      // which read as the view drifting rather than a clean zoom toward one spot. Falls
      // back to the frame's own center (focusSrc null) if there's no cursor sample right at
      // entry. Reset to null between blocks so the next one starts fresh instead of easing
      // in from wherever the last one was pointed.
      if (!activeZoom) {
        zoomFocusRef.current = null;
        activeZoomIdRef.current = null;
      } else if (activeZoom.id !== activeZoomIdRef.current) {
        activeZoomIdRef.current = activeZoom.id;
        if (cursorSample?.pos && track) {
          const frame = frameDimensions(track.metadata);
          const svW = screenVideo.videoWidth;
          const svH = screenVideo.videoHeight;
          zoomFocusRef.current = { x: cursorSample.pos.x * (svW / frame.width), y: cursorSample.pos.y * (svH / frame.height) };
        } else {
          zoomFocusRef.current = null;
        }
      }
      // else: same block continuing — zoomFocusRef stays exactly as captured at entry,
      // through the ease-in, the hold, and the ease-out alike.
      const zoomFocusSrc = zoomFocusRef.current;

      // Resolve this frame's screen/camera boxes — every format works the same way: the
      // screen and camera are always freely drag-positioned/resized, overlap allowed (the
      // camera draws on top). interactionRef is refreshed every frame so pointer handlers
      // always hit-test against this frame's geometry.
      const fullBox: Rect = { x: 0, y: 0, w: canvas.width, h: canvas.height };

      const cameraSize = cameraBubbleSize(cam, fullBox);
      const cameraDrag: DragRegion = {
        originX: 0,
        originY: 0,
        // Not floored at 0 — once the box is bigger than the canvas, this goes negative,
        // which keeps resolveDragPos's position formula continuous (e.g. it centers an
        // oversized box) instead of the position freezing the instant it crosses over.
        travelW: canvas.width - cameraSize.width,
        travelH: canvas.height - cameraSize.height,
        boxW: cameraSize.width,
        boxH: cameraSize.height,
      };
      const cameraOrigin = resolveDragPos(layoutSettings.freeCameraPos, cameraDrag, { x: 100, y: 100 });

      const cameraRect: Rect | null =
        !cam.hidden && hasCameraSource && showCameraTrackContent
          ? { x: cameraOrigin.x, y: cameraOrigin.y, w: cameraSize.width, h: cameraSize.height }
          : null;

      // Screen is a true free rectangle — width and height independently set (and drag-
      // resizable), same idea as the camera bubble's own corner-resize. Always
      // draggable/resizable regardless of format/landscapeMode: the one exception is
      // "split" while freeScreenPos is still null ("nothing set in screen" — see
      // buildSplitSlots in LayoutEditPanel, the only thing that ever resets it to null),
      // where the box below gets overridden to fill whatever the camera isn't using
      // instead. The instant the user actually drags/resizes it, freeScreenPos becomes
      // non-null and this permanently stops applying — dragging still works throughout,
      // since screenDrag is rebuilt from *whichever* box's real dimensions end up in use.
      const boxW = (layoutSettings.freeScreenSizePct / 100) * canvas.width;
      const boxH = (layoutSettings.freeScreenHeightPct / 100) * canvas.height;
      let screenDrag: DragRegion = {
        originX: 0,
        originY: 0,
        // Not floored at 0 — see the identical note on cameraDrag above.
        travelW: canvas.width - boxW,
        travelH: canvas.height - boxH,
        boxW,
        boxH,
      };
      // {50,50} — the untouched default (freeScreenSizePct/HeightPct both 100, full-bleed
      // on both axes) is degenerate on both, so this needs to be the neutral on-canvas
      // point (see pctToOffset) rather than the old left/center bias from before "full"
      // meant genuinely full-bleed both ways. While reelScreenFull, freeScreenPos is
      // repurposed entirely as the pan offset below (dragging pans the crop, not the box —
      // see dragStateRef's "pan" mode), so the box's own position always stays neutral.
      const screenOrigin = resolveDragPos(layoutSettings.reelScreenFull ? null : layoutSettings.freeScreenPos, screenDrag, {
        x: 50,
        y: 50,
      });
      let screenBox: Rect = { x: screenOrigin.x, y: screenOrigin.y, w: boxW, h: boxH };

      if (layoutSettings.format === "landscape" && layoutSettings.landscapeMode === "split" && layoutSettings.freeScreenPos === null && cameraRect) {
        const distLeft = cameraRect.x;
        const distRight = canvas.width - (cameraRect.x + cameraRect.w);
        const distTop = cameraRect.y;
        const distBottom = canvas.height - (cameraRect.y + cameraRect.h);
        const minDist = Math.min(distLeft, distRight, distTop, distBottom);
        if (minDist === distLeft) {
          const x = cameraRect.x + cameraRect.w;
          screenBox = { x, y: 0, w: Math.max(1, canvas.width - x), h: canvas.height };
        } else if (minDist === distRight) {
          screenBox = { x: 0, y: 0, w: Math.max(1, cameraRect.x), h: canvas.height };
        } else if (minDist === distTop) {
          const y = cameraRect.y + cameraRect.h;
          screenBox = { x: 0, y, w: canvas.width, h: Math.max(1, canvas.height - y) };
        } else {
          screenBox = { x: 0, y: 0, w: canvas.width, h: Math.max(1, cameraRect.y) };
        }
        // Rebuilt from the derived box's own size, not freeScreenSizePct/HeightPct (which
        // aren't in play here) — so a move/resize started from this box, mid-derivation,
        // computes against its actual current dimensions rather than stale unrelated ones.
        screenDrag = {
          originX: 0,
          originY: 0,
          travelW: canvas.width - screenBox.w,
          travelH: canvas.height - screenBox.h,
          boxW: screenBox.w,
          boxH: screenBox.h,
        };
      }

      // Resize handles — a small grab zone at each of a draggable box's 4 corners.
      const handleSize = Math.max(14, Math.min(canvas.width, canvas.height) * 0.022);
      const screenResizeHandles = cornerHandles(screenBox, handleSize);
      const cameraResizeHandles = cameraRect ? cornerHandles(cameraRect, handleSize) : null;

      interactionRef.current = {
        screenRect: screenBox,
        cameraRect,
        screenDrag,
        cameraDrag,
        screenResizeHandles,
        cameraResizeHandles,
        canvasW: canvas.width,
        canvasH: canvas.height,
      };

      const screenFitMode = layoutSettings.format === "reel" && layoutSettings.reelScreenFull ? "cover" : "contain";
      const screenPanPct = layoutSettings.reelScreenFull
        ? { x: layoutSettings.freeScreenPos?.xPct ?? 50, y: layoutSettings.freeScreenPos?.yPct ?? 50 }
        : { x: 50, y: 50 };
      const fit = drawScreenContent(ctx, screenVideo, zoomedBg, screenBox, screenFitMode, screenPanPct, showScreenContent, zoomFocusSrc);
      const { screenDrawX, screenDrawY, fitScale, srcX, srcY, svW, svH } = fit;

      // Synthetic cursor overlay — screenVideo never has the cursor baked in (see
      // getEditProjectMedia), so it's drawn live here from the recorded track (reusing the
      // sample taken above for the zoom-focus crop, rather than searching it again).
      // Skipped entirely during a deleted (blank) Clips stretch, same as the screen/camera
      // content — and skipped altogether when cursorBakedIn, since screenVideo *does* have
      // a real one baked in there and drawing this on top of it would show two cursors.
      if (showScreenContent && track && cursorSample && !cursorBakedInRef.current) {
        const { point, pos } = cursorSample;
        const frame = frameDimensions(track.metadata);
        const icon = track.icons[point.icon];
        if (pos && icon) {
          const cur = cursorRef.current;
          const scaleX = (svW / frame.width) * fitScale;
          const scaleY = (svH / frame.height) * fitScale;
          const sizeMul = cur.sizePct / 100;
          const px = screenDrawX + (pos.x * (svW / frame.width) - srcX) * fitScale;
          const py = screenDrawY + (pos.y * (svH / frame.height) - srcY) * fitScale;
          const r = Math.max(1, 9 * ((scaleX + scaleY) / 2) * sizeMul);

          if (cur.style === "default") {
            // The real captured OS cursor bitmap doesn't reliably carry per-pixel alpha
            // (system cursors are often legacy AND/XOR-mask cursors under the hood), so
            // tinting it via a composite trick paints a solid box instead of the cursor's
            // actual shape — not fixable from here without also fixing that capture, so
            // "default" just always renders in its own captured colors.
            const drawW = icon.width * scaleX * sizeMul;
            const drawH = icon.height * scaleY * sizeMul;
            const hx = icon.hotspotX * scaleX * sizeMul;
            const hy = icon.hotspotY * scaleY * sizeMul;
            ctx.drawImage(icon.img, px - hx, py - hy, drawW, drawH);
          } else {
            ctx.save();
            if (cur.style === "arrow") {
              const scale = (r * 2.4) / 24;
              ctx.translate(px, py);
              ctx.scale(scale, scale);
              ctx.translate(-ARROW_HOTSPOT.x, -ARROW_HOTSPOT.y);
              ctx.lineJoin = "round";
              if (cur.filled) {
                ctx.strokeStyle = "rgba(0, 0, 0, .45)";
                ctx.lineWidth = 3;
                ctx.stroke(ARROW_ICON_PATH);
                ctx.fillStyle = cur.color;
                ctx.fill(ARROW_ICON_PATH);
              } else {
                ctx.strokeStyle = cur.color;
                ctx.lineWidth = 2.2;
                ctx.stroke(ARROW_ICON_PATH);
              }
            } else if (cur.style === "circle") {
              ctx.beginPath();
              ctx.arc(px, py, r, 0, Math.PI * 2);
              if (cur.filled) {
                ctx.fillStyle = cur.color;
                ctx.fill();
              }
              ctx.lineWidth = Math.max(1, r * 0.22);
              ctx.strokeStyle = cur.color;
              ctx.stroke();
            } else if (cur.style === "hand") {
              const scale = (r * 2.6) / 256;
              ctx.translate(px, py);
              ctx.scale(scale, scale);
              ctx.translate(-HAND_POINTING_HOTSPOT.x, -HAND_POINTING_HOTSPOT.y);
              ctx.lineJoin = "round";
              // Both Phosphor weights are closed, solid shapes (unlike lucide's open
              // strokes) — "filled" is the bold "fill" weight with a dark backing stroke
              // for contrast against video content; "not filled" is just the lighter
              // "regular" weight filled plainly, matching how phosphoricons.com itself
              // renders that weight (flat fill, no outline).
              if (cur.filled) {
                ctx.strokeStyle = "rgba(0, 0, 0, .45)";
                ctx.lineWidth = 10;
                ctx.stroke(HAND_POINTING_FILL_PATH);
                ctx.fillStyle = cur.color;
                ctx.fill(HAND_POINTING_FILL_PATH);
              } else {
                ctx.fillStyle = cur.color;
                ctx.fill(HAND_POINTING_REGULAR_PATH);
              }
            } else if (cur.style === "mouse-simple") {
              const scale = (r * 2.6) / 256;
              ctx.translate(px, py);
              ctx.scale(scale, scale);
              ctx.translate(-MOUSE_HOTSPOT.x, -MOUSE_HOTSPOT.y);
              ctx.lineJoin = "round";
              if (cur.filled) {
                ctx.strokeStyle = "rgba(0, 0, 0, .45)";
                ctx.lineWidth = 10;
                ctx.stroke(MOUSE_SIMPLE_FILL_PATH);
                ctx.fillStyle = cur.color;
                ctx.fill(MOUSE_SIMPLE_FILL_PATH);
              } else {
                ctx.fillStyle = cur.color;
                ctx.fill(MOUSE_SIMPLE_REGULAR_PATH);
              }
            } else if (cur.style === "mouse-pointer") {
              const scale = (r * 2.4) / 24;
              ctx.translate(px, py);
              ctx.scale(scale, scale);
              ctx.translate(-MOUSE_POINTER_HOTSPOT.x, -MOUSE_POINTER_HOTSPOT.y);
              ctx.lineJoin = "round";
              ctx.lineCap = "round";
              if (cur.filled) {
                ctx.strokeStyle = "rgba(0, 0, 0, .45)";
                ctx.lineWidth = 3;
                ctx.stroke(MOUSE_POINTER_ARROW_PATH);
                ctx.fillStyle = cur.color;
                ctx.fill(MOUSE_POINTER_ARROW_PATH);
              } else {
                ctx.strokeStyle = cur.color;
                ctx.lineWidth = 2.2;
                ctx.stroke(MOUSE_POINTER_ARROW_PATH);
              }
              ctx.strokeStyle = cur.color;
              ctx.lineWidth = cur.filled ? 2.6 : 2;
              ctx.stroke(MOUSE_POINTER_TAIL_PATH);
            } else if (cur.style === "crosshair") {
              const tick = r * 0.5;
              if (cur.filled) {
                ctx.beginPath();
                ctx.arc(px, py, r, 0, Math.PI * 2);
                ctx.fillStyle = cur.color;
                ctx.fill();
              } else {
                ctx.beginPath();
                ctx.arc(px, py, r, 0, Math.PI * 2);
                ctx.strokeStyle = "rgba(0, 0, 0, .45)";
                ctx.lineWidth = Math.max(1, r * 0.16);
                ctx.stroke();
                ctx.strokeStyle = cur.color;
                ctx.lineWidth = Math.max(1, r * 0.1);
                ctx.stroke();
              }
              const drawTicks = () => {
                ctx.beginPath();
                ctx.moveTo(px + r, py);
                ctx.lineTo(px + r + tick, py);
                ctx.moveTo(px - r, py);
                ctx.lineTo(px - r - tick, py);
                ctx.moveTo(px, py + r);
                ctx.lineTo(px, py + r + tick);
                ctx.moveTo(px, py - r);
                ctx.lineTo(px, py - r - tick);
                ctx.stroke();
              };
              ctx.strokeStyle = "rgba(0, 0, 0, .45)";
              ctx.lineWidth = Math.max(1, r * 0.16);
              drawTicks();
              ctx.strokeStyle = cur.color;
              ctx.lineWidth = Math.max(1, r * 0.1);
              drawTicks();
            }
            ctx.restore();
          }

          // Click animation/sound — advances only while playback moves forward, so
          // pausing or scrubbing backward can't re-trigger a click that already fired.
          // Timed off currentMs (edited-timeline ms), not wall-clock — so the ripple
          // duration below tracks actual playback progress (freezing correctly if
          // paused) and stays correct during export's non-realtime frame stepping, where
          // real elapsed time bears no relation to how much edited time a frame covers.
          const clicks = track.metadata.clicks;
          if (clicks && clicks.length > 0 && cursorTMs > lastPlaybackMsRef.current) {
            for (const clickT of clicks) {
              if (clickT > lastPlaybackMsRef.current && clickT <= cursorTMs) {
                if (cur.clickEffect) {
                  rippleRef.current = { startedAt: currentMs, x: px, y: py, r, style: cur.clickAnimationStyle };
                }
                // Export renders its own click sounds separately and offline (see
                // renderExportAudio) — this live path is pinned to the AudioContext's
                // real-time clock, which export's non-realtime frame stepping can't use.
                if (cur.clickSound && !isExportingRef.current) playClickSound(audioCtxRef, cur.clickSoundStyle);
              }
            }
          }

          const ripple = rippleRef.current;
          if (ripple) {
            const elapsed = currentMs - ripple.startedAt;
            if (elapsed > RIPPLE_DURATION_MS) {
              rippleRef.current = null;
            } else {
              const t = elapsed / RIPPLE_DURATION_MS;
              const color = cursorRef.current.color;
              ctx.save();
              if (ripple.style === "pulse") {
                ctx.beginPath();
                ctx.arc(ripple.x, ripple.y, ripple.r * (1 + t * 1.4), 0, Math.PI * 2);
                ctx.fillStyle = withAlpha(color, 0.35 * (1 - t));
                ctx.fill();
              } else if (ripple.style === "burst") {
                const spikes = 8;
                const inner = ripple.r * (1 + t * 1.2);
                const outer = inner + ripple.r * 1.6 * (1 - t * 0.3);
                ctx.strokeStyle = withAlpha(color, 0.75 * (1 - t));
                ctx.lineWidth = Math.max(1, ripple.r * 0.22 * (1 - t));
                ctx.lineCap = "round";
                for (let i = 0; i < spikes; i++) {
                  const angle = (i / spikes) * Math.PI * 2;
                  ctx.beginPath();
                  ctx.moveTo(ripple.x + Math.cos(angle) * inner, ripple.y + Math.sin(angle) * inner);
                  ctx.lineTo(ripple.x + Math.cos(angle) * outer, ripple.y + Math.sin(angle) * outer);
                  ctx.stroke();
                }
              } else {
                ctx.beginPath();
                ctx.arc(ripple.x, ripple.y, ripple.r * (1 + t * 2.2), 0, Math.PI * 2);
                ctx.lineWidth = Math.max(1, ripple.r * 0.25 * (1 - t));
                ctx.strokeStyle = withAlpha(color, 0.6 * (1 - t));
                ctx.stroke();
              }
              ctx.restore();
            }
          }
        }
        lastPlaybackMsRef.current = cursorTMs;
      }

      const source = cameraSource;
      if (cameraRect && source) {
        drawCameraBubbleAt(ctx, source, cam, cameraRect.x, cameraRect.y, cameraRect.w, cameraRect.h);
      }

      // Drag/resize affordance — a faint outline plus a handle at each of a box's 4
      // corners. Editing-only chrome, so skipped entirely while exportVideo() is capturing
      // this same canvas — otherwise it'd be permanently baked into the recorded pixels.
      if (!isExportingRef.current) {
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, .35)";
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(screenBox.x + 1, screenBox.y + 1, screenBox.w - 2, screenBox.h - 2);
        if (cameraRect) ctx.strokeRect(cameraRect.x + 1, cameraRect.y + 1, cameraRect.w - 2, cameraRect.h - 2);
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(255, 255, 255, .9)";
        ctx.strokeStyle = "rgba(0, 0, 0, .55)";
        ctx.lineWidth = 1;
        for (const handles of [screenResizeHandles, cameraResizeHandles]) {
          if (!handles) continue;
          for (const corner of CORNERS) {
            const handle = handles[corner];
            ctx.beginPath();
            ctx.arc(handle.x + handle.w / 2, handle.y + handle.h / 2, handle.w / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // Snap guides (25%/50%/75% of each axis) — drawn only while actively dragging (see
      // onPointerMove), and never during export (same editing-only-chrome reasoning as
      // the drag affordance above).
      const guide = guideRef.current;
      if (!isExportingRef.current && (guide.v.length > 0 || guide.h.length > 0)) {
        ctx.save();
        ctx.strokeStyle = GUIDE_COLOR;
        ctx.lineWidth = Math.max(1, Math.min(canvas.width, canvas.height) * 0.0025);
        for (const f of guide.v) {
          ctx.beginPath();
          ctx.moveTo(canvas.width * f, 0);
          ctx.lineTo(canvas.width * f, canvas.height);
          ctx.stroke();
        }
        for (const f of guide.h) {
          ctx.beginPath();
          ctx.moveTo(0, canvas.height * f);
          ctx.lineTo(canvas.width, canvas.height * f);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    drawFrameRef.current = draw;
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      drawFrameRef.current = null;
      audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  function togglePlay() {
    const screenVideo = screenVideoRef.current;
    const cameraVideo = cameraVideoRef.current;
    if (!screenVideo) return;
    if (playing) {
      screenVideo.pause();
      cameraVideo?.pause();
      isPlayingRef.current = false;
      setPlaying(false);
    } else {
      isPlayingRef.current = true;
      setPlaying(true);
      // If the playhead is currently sitting in a gap on a given track, the draw loop
      // advances it by wall-clock time instead — that track's video element stays paused
      // until playback reaches real footage again, so don't start it here. Screen and
      // Camera are checked independently since their pieces now drag/trim/gap
      // independently of each other.
      if (activeClipIdRef.current !== null) screenVideo.play().catch(() => {});
      if (activeCameraClipIdRef.current !== null) cameraVideo?.play().catch(() => {});
    }
  }

  // Both the preview's own scrub bar and the external Timeline ruler seek by *edited*
  // ms — this resolves that (checking every overlapping clip, topmost wins) to a raw
  // source position and moves the actual video elements there, same as the draw loop's
  // own boundary-crossing jumps. Screen and Camera are resolved independently against
  // the same edited ms, same as the draw loop.
  function seekToEditedMs(editedMs: number) {
    const screenVideo = screenVideoRef.current;
    const cameraVideo = cameraVideoRef.current;
    if (!screenVideo || !screenVideo.duration) return;
    const sourceDurationMs = screenVideo.duration * 1000;
    // See the draw loop's identical computation for the reasoning behind all of this.
    const cameraSourceDurationMs = cameraDurationMsRef.current ?? sourceDurationMs;
    const offsetMs = sideClipOffsetMsRef.current;
    const alignedLengthMs = Math.min(Math.max(0, sourceDurationMs - offsetMs), cameraSourceDurationMs);
    const clips = effectiveClips(timelineRef.current.clips, sourceDurationMs, 0, alignedLengthMs, offsetMs);
    const cameraClips = effectiveClips(timelineRef.current.cameraClips, cameraSourceDurationMs, 0, alignedLengthMs);
    const totalMs = Math.max(totalClipsExtentMs(clips), totalClipsExtentMs(cameraClips));
    editedMsRef.current = Math.max(0, Math.min(totalMs, editedMs));
    const resolved = resolveClipAt(clips, editedMsRef.current);
    if (resolved) {
      screenVideo.currentTime = resolved.sourceMs / 1000;
      activeClipIdRef.current = resolved.clip.id;
    } else {
      // Landed in a gap — nothing to seek to, the draw loop's wall-clock advancement
      // (editedMsRef, just set above) picks up from here.
      screenVideo.pause();
      activeClipIdRef.current = null;
    }
    const cameraResolved = resolveClipAt(cameraClips, editedMsRef.current);
    if (cameraVideo) {
      if (cameraResolved) {
        cameraVideo.currentTime = cameraResolved.sourceMs / 1000;
      } else {
        cameraVideo.pause();
      }
    }
    activeCameraClipIdRef.current = cameraResolved ? cameraResolved.clip.id : null;
    setProgress(totalMs > 0 ? editedMsRef.current / totalMs : 0);
  }

  function seekTo(fraction: number) {
    seekToEditedMs(fraction * duration * 1000);
  }

  // Frame-stepped export originally seeked each video element to its exact resolved
  // position once *per output frame* (one currentTime write + a wait for it to land, for
  // both screen and camera, ~every 33ms of edited time). That turned out far slower than
  // the real-time capture it replaced — Chromium treats *any* currentTime write as a real
  // seek operation with meaningful fixed overhead, even a forward step of one frame, so a
  // few thousand of them (a 1-minute/30fps export needs ~1800) added up to minutes.
  // Continuous forward playback is what browsers actually optimize for, so the loop below
  // seeks only once per *segment* — a maximal stretch where neither track's resolved clip
  // changes — then lets both videos play forward on their own (sped up, since we don't
  // need real-time pacing) and just waits for each one's own decode to catch up to each
  // output frame's target position, via requestVideoFrameCallback rather than a seek.

  // Chromium's practical ceiling for HTMLMediaElement.playbackRate is 16, but pushing a
  // decoder anywhere near that lets it start silently dropping frames to keep up rather
  // than decoding every one — invisible to waitUntilSourceTime (whichever frame is
  // "current" always satisfies its own timestamp check), so the result isn't a failure,
  // just a frame that got skipped and, symmetrically, an earlier one that then got drawn
  // for multiple consecutive output frames while decode caught back up. That reads as a
  // stutter — easy to miss at 1x scale, glaring under a zoom block's magnification. 4x is
  // comfortably inside what software decode can sustain frame-for-frame for typical
  // screen-recording content, at some cost to export speed.
  const MAX_EXPORT_PLAYBACK_RATE = 4;

  // How close to a source file's *reported* duration a stalled wait has to be before it's
  // read as "this file has no more frames" rather than "this decode is being slow" (see
  // waitUntilSourceTime's bail path). Generous, because the gap being detected is exactly
  // a duration that can't be trusted: a MediaRecorder webm's duration is derived from its
  // last block timestamp, and a camera file routinely stops a beat before the screen
  // recording it's paired with, so the unreachable stretch is a fraction of a second in
  // the good case and the whole overhang of a stale, over-long camera clip in the bad one.
  const EXPORT_TAIL_TOLERANCE_SEC = 2;

  /** Every edited-ms position where the screen or camera clip resolution could possibly
   *  change (each clip's own start and end) — the boundaries between export's seek
   *  segments. Two clips only need re-seeking exactly at the points where what's
   *  "current" for either track actually changes; everywhere in between, both tracks
   *  just keep playing forward from wherever the previous segment left them. */
  function exportSegmentBreaks(totalMs: number, clips: TimelineClip[], cameraClips: TimelineClip[]): number[] {
    const points = new Set<number>([0, totalMs]);
    for (const list of [clips, cameraClips]) {
      for (const c of list) {
        const dur = Math.max(0, c.sourceEnd - c.sourceStart);
        points.add(Math.min(Math.max(c.timelineStart, 0), totalMs));
        points.add(Math.min(Math.max(c.timelineStart + dur, 0), totalMs));
      }
    }
    return Array.from(points).sort((a, b) => a - b);
  }

  /** Seeks once and waits for that exact frame to actually be decoded and ready — used
   *  only at a segment's start (a handful of times per export), unlike the old
   *  per-output-frame version this replaces. */
  function seekAndWait(video: HTMLVideoElement, sourceSec: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(done, 300);
      function done() {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        video.removeEventListener("seeked", done);
        resolve();
      }
      video.addEventListener("seeked", done, { once: true });
      video.currentTime = sourceSec;
    });
  }

  /** Waits for `video` — already playing forward continuously (see exportVideo's segment
   *  loop) — to reach `targetSec` on its own, via requestVideoFrameCallback rather than a
   *  seek: each firing is just "a new decoded frame is ready, check again," cheap however
   *  many times it takes, in contrast to a currentTime write's fixed per-call overhead.
   *  Resolves immediately, with no callback round-trip at all, if already there. Falls
   *  back to polling via rAF on engines without rVFC.
   *
   *  `reachableEndSec` is the export's own running record (one entry per element, reset
   *  per export — see exportVideo) of how far each source has ever actually been able to
   *  decode to; it's both read and written here. */
  function waitUntilSourceTime(
    video: HTMLVideoElement,
    targetSec: number,
    reachableEndSec: Map<HTMLVideoElement, number>
  ): Promise<void> {
    // Already known to be past this source's last decodable frame — no amount of waiting
    // will ever produce it, so skip the whole play/wait/stall-timeout round trip rather
    // than rediscovering the same dead end once per remaining output frame (see finish()'s
    // bail path for what put this entry here). Resolving immediately leaves the element
    // frozen exactly where it ran out, which is what live preview shows there too.
    const reachableEnd = reachableEndSec.get(video);
    if (reachableEnd !== undefined && targetSec > reachableEnd) return Promise.resolve();
    // Already there — common now that the export loop (see below) pauses the instant
    // each frame's target is reached and only resumes a track when it's genuinely behind
    // the next one, rather than unconditionally every frame. Calling play() when the
    // frozen position already satisfies the next target is exactly the pattern that can
    // leave Chromium's video element stuck: a play() request "interrupted" by a pause()
    // called right after it, before the browser's own internal playback state has
    // actually settled. Skipping the no-op play()/pause() pair entirely avoids that.
    if (video.currentTime >= targetSec) return Promise.resolve();
    video.play().catch(() => {});
    return new Promise((resolve) => {
      let settled = false;
      let lastMediaTime = video.currentTime;
      let stallTimer: ReturnType<typeof setTimeout> | null = null;
      // Defensive only — normally resolved by the check below (or the stall timer just
      // below it). Guards against play() silently never advancing at all (an autoplay
      // policy quirk despite being muted) leaving nothing else to ever satisfy this
      // promise, which would otherwise hang the whole export indefinitely.
      const hardTimeout = setTimeout(() => finish(false), 4000);
      function finish(reached: boolean) {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        if (stallTimer) clearTimeout(stallTimer);
        // Gave up without ever reaching the target, at a position within touching distance
        // of where the file claims to end: that's the source running out of content, not a
        // slow decode. Record how far it genuinely got, so every later frame skips the
        // wait outright (see the top of this function) instead of each burning its own
        // stall timeout. Without that memo, a camera file ending a second before the
        // screen recording it's paired with cost 400ms-4s of dead waiting on *every*
        // output frame of that overhang — which is both why the last couple of percent of
        // an export took longer than all the rest of it put together, and why that stretch
        // came out juddering rather than cleanly frozen: each of those frames bailed with
        // the camera lagging a little further behind its own target, so its last fraction
        // of a second got smeared across the whole tail in slow motion. Never lowered by a
        // later bail (Math.max) — every bail position is by definition somewhere the
        // decoder did reach, so the highest one seen is the best estimate of the true end.
        if (!reached && (video.ended || targetSec >= (video.duration || 0) - EXPORT_TAIL_TOLERANCE_SEC)) {
          reachableEndSec.set(video, Math.max(lastMediaTime, reachableEndSec.get(video) ?? 0));
        }
        // Stop the track the instant this wait is done deciding, win or bail — the
        // segment loop's own pause() call right after Promise.all(waits) is too late to
        // prevent drift accumulated *during* this wait itself, which is exactly what a
        // stalled target used to do: play() sped up 4x for the full length of whichever
        // timeout fired, racing arbitrarily far past the requested position before the
        // loop ever got a chance to pause it.
        video.pause();
        resolve();
      }
      // A target time can turn out to be unreachable near a clip's tail end — a source
      // file's reported duration is frequently an overestimate of what's actually
      // decodable (the same webm quirk documented in mediaProtocol.ts re: duration:
      // Infinity), so the last output frame or two can ask for a position the decoder
      // never actually produces. Rather than always burning the full hard timeout above
      // while the video keeps playing forward in the background — up to ~16 simulated
      // seconds of drift at 4x over 4 real seconds, dumped into a single captured frame
      // as a jarring jump — bail out as soon as decode visibly stops making forward
      // progress at all. 4x playback comfortably sustains a new frame every well under
      // 400ms for ordinary screen-recording content (see MAX_EXPORT_PLAYBACK_RATE's own
      // comment), so a gap that long with no advance means genuinely stuck, not just slow.
      function armStallTimer() {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => finish(false), 400);
      }
      // requestVideoFrameCallback's own mediaTime — the exact timestamp of the frame that
      // was actually decoded and presented — rather than video.currentTime, which is a
      // live-updating estimate of "now" that can silently outrun what's actually been
      // decoded when playing forward at a high rate (see MAX_EXPORT_PLAYBACK_RATE):
      // currentTime reads "caught up" a beat before a same-timestamp frame is genuinely
      // ready, so drawing on that signal alone can repeat one decoded frame across several
      // output frames, then jump once decode actually catches up — a stutter that's easy
      // to miss at 1x scale but glaring wherever the frame's magnified (a zoom block).
      const check = (_now: number, metadata: VideoFrameCallbackMetadata) => {
        if (settled) return;
        if (metadata.mediaTime >= targetSec || video.ended) {
          finish(metadata.mediaTime >= targetSec);
          return;
        }
        if (metadata.mediaTime > lastMediaTime) {
          lastMediaTime = metadata.mediaTime;
          armStallTimer();
        }
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(check);
        else requestAnimationFrame(fallbackCheck);
      };
      const fallbackCheck = () => {
        if (settled) return;
        if (video.currentTime >= targetSec || video.ended) {
          finish(video.currentTime >= targetSec);
          return;
        }
        if (video.currentTime > lastMediaTime) {
          lastMediaTime = video.currentTime;
          armStallTimer();
        }
        requestAnimationFrame(fallbackCheck);
      };
      armStallTimer();
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(check);
      else fallbackCheck();
    });
  }

  // Renders export's entire audio track in one deterministic, non-realtime pass via
  // OfflineAudioContext — completely decoupled from the frame-stepped video capture (see
  // exportVideo), and the only way to get synthesized click sounds into the export at
  // all: playClickSound's envelopes are pinned to a live AudioContext's real-time clock,
  // which has no meaning during non-realtime rendering. Mirrors the live draw loop's own
  // audio rules: the source audio comes from whichever element/clips list actually
  // carries it (the separate camera file's own cameraClips if there is one, else the
  // screen file's clips — see mutedRef's declaration), muted by the Mute toggle; clicks
  // are always keyed to the screen recording's own source clock (the cursor track is
  // always tied to screenFilePath, camera or not) and skipped entirely when the screen
  // recording has a real cursor baked into its pixels, exactly like the live click
  // detection this mirrors (see cursorBakedInRef's own doc comment). Returns null when
  // there's nothing to render (muted, no click sound, no clicks) rather than encoding a
  // silent WAV nobody needs. `decodeAudio` (the caller's ffmpeg-backed decoder — see
  // exportVideo's own opts) is what actually turns the source file into something
  // decodeAudioData can reliably read in full; decoding the raw source directly here
  // doesn't work; see decodeAudio's own doc comment for why.
  async function renderExportAudio(
    totalMs: number,
    // Only for click timing below (see its use at sourceToEditedMs) — audio itself is no
    // longer clip-gated at all (see its own comment further down). Taken from the caller
    // rather than recomputed here so it's guaranteed the exact same default/edited clips
    // actually driving the video export, not a second, potentially drifting computation.
    clips: TimelineClip[],
    decodeAudio: (filePath: string) => Promise<ArrayBuffer>
  ): Promise<ArrayBuffer | null> {
    const muted = mutedRef.current;
    const cur = cursorRef.current;
    const track = cursorTrackRef.current;
    const clicks = !cursorBakedInRef.current && cur.clickSound ? (track?.metadata.clicks ?? []) : [];

    if (muted && clicks.length === 0) return null;

    const SAMPLE_RATE = 44100;
    const numSamples = Math.max(1, Math.ceil((totalMs / 1000) * SAMPLE_RATE));
    const offlineCtx = new OfflineAudioContext(2, numSamples, SAMPLE_RATE);

    if (!muted) {
      // Two independent recorded sources, mixed here into one export track — the same two
      // the live preview plays through two separate elements (see mutedRef's own comment):
      //
      //  - the screen track, which is where system audio ("system sound") lives on every
      //    platform now, and which for an already-muxed single-file source is the entire
      //    soundtrack on its own. Always at offset 0: it *is* the reference timeline.
      //  - the side clip's mic — the camera track's own audio, or a screen-only
      //    recording's separately-captured audio.wav — which starts sideClipOffsetMs into
      //    that timeline (see sideClipOffsetMsRef's doc comment) because its recorder
      //    starts after screen capture is already rolling.
      //
      // Either can be missing or silent, and both are decoded independently so one failing
      // never costs the other: a project recorded with system sound off has a silent screen
      // track, one recorded with no mic has no side clip at all, and anything recorded
      // before system audio moved to the screen track has both mixed together in the side
      // clip against a silent screen track — which still comes out right here, since that
      // mixed clip is simply one of the two sources and the other contributes nothing.
      const sideAudioPath = cameraFilePath ?? audioFilePath;
      const sources: { path: string; startSec: number }[] = [
        { path: screenFilePath, startSec: 0 },
        ...(sideAudioPath ? [{ path: sideAudioPath, startSec: Math.max(0, sideClipOffsetMsRef.current / 1000) }] : []),
      ];

      for (const { path: sourceAudioPath, startSec } of sources) {
        try {
          const wavBytes = await decodeAudio(sourceAudioPath);
          const decoded = await offlineCtx.decodeAudioData(wavBytes);
        // One continuous, unedited buffer source spanning the whole export (from its own
        // start offset on) — not gated by either track's own clips. Neither the Camera
        // track's pieces (see cameraClips's own independent-editing comment) nor the screen
        // Clips track's own cuts/gaps are something the user is actually editing *audio* by
        // touching: a gap on either track just means blank visual background for that
        // stretch (see the draw loop's own "plays as real, silent background" comment) —
        // real elapsed time nothing stops the underlying recording's own audio from
        // continuing straight through, on both counts. edited-ms and raw source-ms are the
        // same clock for audio's purposes specifically because of that: it's the one track
        // never subject to remapping, past the fixed start-offset shift.
          const durSec = Math.min(decoded.duration, Math.max(0, totalMs / 1000 - startSec));
          if (durSec > 0) {
            const src = offlineCtx.createBufferSource();
            src.buffer = decoded;
            src.connect(offlineCtx.destination);
            src.start(startSec, 0, durSec);
          }
        } catch {
          // No audio track on this source, or it failed to decode — skip just this one.
          // The other source (and the click sounds below) still render.
        }
      }
    }

    for (const clickT of clicks) {
      const editedMs = sourceToEditedMs(clips, clickT);
      if (editedMs === null || editedMs < 0 || editedMs >= totalMs) continue;
      scheduleClickEnvelope(offlineCtx, offlineCtx.destination, cur.clickSoundStyle, editedMs / 1000);
    }

    const rendered = await offlineCtx.startRendering();
    return encodeWavPcm16(rendered);
  }

  /** JPEG-encodes the canvas's current pixels — the per-frame payload for the mjpeg
   *  fallback sink only (see createMjpegFrameSink). JPEG, not PNG: it's the format
   *  ffmpeg's image2pipe+mjpeg demuxer expects on the other end, and its lossyness is
   *  inconsequential since ffmpeg re-encodes to H.264 afterward on that path anyway.
   *
   *  This call is also precisely why that path is now only a fallback: measured on a
   *  1920x1080 canvas it costs ~50ms per frame, it barely gets cheaper at lower quality
   *  settings, and it does not parallelize (eight concurrent calls still average
   *  ~50ms/frame) — it was single-handedly essentially all of export wall-clock time,
   *  while ffmpeg idled with ~155fps of spare capacity. The h264 sink below does the same
   *  job in ~15ms. */
  function canvasToJpegArrayBuffer(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Failed to encode export frame"));
            return;
          }
          blob.arrayBuffer().then(resolve, reject);
        },
        "image/jpeg",
        0.92
      );
    });
  }

  /** Where each rendered output frame goes. Two implementations — createH264FrameSink
   *  (the fast path) and createMjpegFrameSink (the fallback) — so the export loop itself
   *  doesn't have to care which pipeline is running. */
  interface ExportFrameSink {
    /** Tells the main process which ffmpeg pipeline to spawn (see exportBegin). */
    frameFormat: "h264" | "mjpeg";
    /** Pixel size of what actually gets streamed: the target size on the h264 path (the
     *  sink scales), the raw canvas size on the mjpeg one (ffmpeg scales). */
    sourceWidth: number;
    sourceHeight: number;
    /** Hands the canvas's current pixels over as output frame `index`. Awaiting this is
     *  the loop's backpressure; it does not imply the frame has reached ffmpeg yet. */
    submit: (index: number) => Promise<void>;
    /** Resolves once every submitted frame has been flushed through to onFrame. */
    finish: () => Promise<void>;
    close: () => void;
  }

  /** Mirrors the main process's own estimateBitrateKbps so both pipelines target the same
   *  quality — the renderer just needs it in bits/sec rather than kbit/sec. */
  function estimateExportBitrate(width: number, height: number, fps: number): number {
    return Math.max(1_500_000, Math.round(width * height * fps * 0.08));
  }

  const EXPORT_KEYFRAME_INTERVAL_SECS = 2;
  // How far the encoder and the IPC hand-off are each allowed to run ahead before submit()
  // stops accepting new frames. Deep enough that neither starves waiting on the render
  // loop, shallow enough that a cancel takes effect promptly and memory stays flat.
  const EXPORT_ENCODER_QUEUE_LIMIT = 8;
  const EXPORT_SEND_QUEUE_LIMIT = 16;

  /** The fast sink: encodes each frame to H.264 here in the renderer via WebCodecs
   *  (hardware-backed where available) and streams Annex-B access units, so the main
   *  process only has to mux them (`-c:v copy`) — no JPEG encode here, no decode and no
   *  re-encode there. ~15ms/frame against canvas.toBlob's ~50ms, at ~21KB per frame
   *  against ~150KB.
   *
   *  Scaling happens here rather than in ffmpeg, since a copy-mux can't scale: when the
   *  requested export size differs from the compositor's fixed canvas, frames go through
   *  a scratch canvas at the target size first.
   *
   *  Chromium's AVC encoder emits exactly one chunk per submitted frame, in presentation
   *  order, carrying the timestamps it was given — verified directly, and load-bearing,
   *  since a raw elementary stream has no timestamps of its own and the mux assigns them
   *  positionally from `-r`. Returns null (caller falls back to mjpeg) when WebCodecs is
   *  missing or can't be configured for this size. */
  async function createH264FrameSink(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    fps: number,
    onFrame: (bytes: ArrayBuffer) => Promise<void>
  ): Promise<ExportFrameSink | null> {
    if (typeof VideoEncoder === "undefined") return null;
    const config: VideoEncoderConfig = {
      codec: "avc1.640028", // H.264 High @ 4.0 — the same profile the ffmpeg path targets
      width,
      height,
      bitrate: estimateExportBitrate(width, height, fps),
      framerate: fps,
      avc: { format: "annexb" },
      latencyMode: "quality",
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (!support.supported) return null;
    } catch {
      return null;
    }

    let failure: Error | null = null;
    const fail = (e: unknown) => {
      failure ??= e instanceof Error ? e : new Error(String(e));
    };
    // Chunks reach onFrame strictly in order via this chain — ffmpeg's stdin is one byte
    // stream, so two frames must never be in flight to it at once.
    let sendChain: Promise<void> = Promise.resolve();
    let pendingSends = 0;

    const encoder = new VideoEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        pendingSends += 1;
        sendChain = sendChain
          .then(() => onFrame(bytes.buffer))
          .catch(fail)
          .finally(() => {
            pendingSends -= 1;
          });
      },
      error: fail,
    });
    encoder.configure(config);

    const needsScale = canvas.width !== width || canvas.height !== height;
    const scratch = needsScale ? document.createElement("canvas") : null;
    let scratchCtx: CanvasRenderingContext2D | null = null;
    if (scratch) {
      scratch.width = width;
      scratch.height = height;
      scratchCtx = scratch.getContext("2d");
      if (!scratchCtx) {
        encoder.close();
        return null;
      }
      scratchCtx.imageSmoothingQuality = "high";
    }

    const keyFrameEvery = Math.max(1, Math.round(fps * EXPORT_KEYFRAME_INTERVAL_SECS));

    return {
      frameFormat: "h264",
      sourceWidth: width,
      sourceHeight: height,
      async submit(index: number) {
        if (failure) throw failure;
        if (scratchCtx) scratchCtx.drawImage(canvas, 0, 0, width, height);
        const frame = new VideoFrame(scratch ?? canvas, {
          timestamp: Math.round((index * 1_000_000) / fps),
          duration: Math.round(1_000_000 / fps),
        });
        try {
          encoder.encode(frame, { keyFrame: index % keyFrameEvery === 0 });
        } finally {
          frame.close();
        }
        while (!failure && (encoder.encodeQueueSize > EXPORT_ENCODER_QUEUE_LIMIT || pendingSends > EXPORT_SEND_QUEUE_LIMIT)) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (failure) throw failure;
      },
      async finish() {
        if (failure) throw failure;
        await encoder.flush();
        await sendChain;
        if (failure) throw failure;
      },
      close() {
        try {
          if (encoder.state !== "closed") encoder.close();
        } catch {
          // Already torn down (a cancel mid-flush) — nothing left to release.
        }
      },
    };
  }

  /** The fallback sink: the original JPEG-per-frame pipeline, unchanged. */
  function createMjpegFrameSink(canvas: HTMLCanvasElement, onFrame: (bytes: ArrayBuffer) => Promise<void>): ExportFrameSink {
    return {
      frameFormat: "mjpeg",
      sourceWidth: canvas.width,
      sourceHeight: canvas.height,
      async submit() {
        await onFrame(await canvasToJpegArrayBuffer(canvas));
      },
      async finish() {
        // Nothing buffered — submit() already awaited each frame all the way out.
      },
      close() {
        // No encoder to release.
      },
    };
  }

  // Renders the export frame-by-frame, entirely decoupled from real/wall-clock time — the
  // opposite of a live playback capture (which is bound to take at least as long as the
  // recording itself, however fast the machine is). For each output frame, the segment
  // loop below places both video elements at that frame's exact resolved source position,
  // draw() (the very same per-frame rendering the live preview uses — see isExportingRef's
  // branch in it) paints it, and the result is JPEG-encoded and handed to the caller's
  // onFrame — which, in ExportDialog, streams it straight into a main-process ffmpeg
  // process rather than this component assembling any video itself (see
  // startImagePipeExport's own doc comment for why: a live JPEG stream into
  // image2pipe+mjpeg is unambiguous about frame timing in a way a browser video encoder,
  // it turns out, isn't reliably under load). Audio is rendered as a wholly separate,
  // fully offline pass up front (see renderExportAudio) and handed to beginExport before
  // any frame work starts, since the caller's ffmpeg process needs it as an input the
  // moment it spawns.
  function exportVideo(opts: {
    fps: number;
    /** Final output size. Needed here (rather than only in the caller) because the h264
     *  sink encodes at exactly this size — a `-c:v copy` mux downstream can't rescale. */
    width: number;
    height: number;
    onProgress?: (fraction: number) => void;
    decodeAudio: (filePath: string) => Promise<ArrayBuffer>;
    beginExport: (info: {
      durationSecs: number;
      audioWavBytes: ArrayBuffer | null;
      frameFormat: "h264" | "mjpeg";
      sourceWidth: number;
      sourceHeight: number;
    }) => Promise<boolean>;
    onFrame: (frameBytes: ArrayBuffer) => Promise<void>;
  }): { promise: Promise<void>; cancel: () => void } {
    const canvas = canvasRef.current;
    const screenVideo = screenVideoRef.current;
    if (!canvas || !screenVideo || !screenVideo.duration) {
      return { promise: Promise.reject(new Error("Preview isn't ready yet.")), cancel: () => {} };
    }

    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };

    const promise = (async (): Promise<void> => {
      const cameraVideo = cameraVideoRef.current;
      screenVideo.pause();
      cameraVideo?.pause();
      isPlayingRef.current = false;
      setPlaying(false);

      const sourceDurationMs = screenVideo.duration * 1000;
      // See the live draw loop's identical computation for the reasoning behind all of this.
      const cameraSourceDurationMs = cameraDurationMsRef.current ?? sourceDurationMs;
      const offsetMs = sideClipOffsetMsRef.current;
      const alignedLengthMs = Math.min(Math.max(0, sourceDurationMs - offsetMs), cameraSourceDurationMs);
      const clips = effectiveClips(timelineRef.current.clips, sourceDurationMs, 0, alignedLengthMs, offsetMs);
      const cameraClips = effectiveClips(timelineRef.current.cameraClips, cameraSourceDurationMs, 0, alignedLengthMs);
      const totalMs = Math.max(totalClipsExtentMs(clips), totalClipsExtentMs(cameraClips));
      if (totalMs <= 0) throw new Error("There's nothing on the timeline to export.");

      const audioWavBytes = await renderExportAudio(totalMs, clips, opts.decodeAudio);
      if (cancelled) throw new ExportCancelledError();

      // Resolved before beginExport, since which sink we got is what decides which ffmpeg
      // pipeline the main process spawns.
      const sink =
        (await createH264FrameSink(canvas, opts.width, opts.height, opts.fps, opts.onFrame)) ??
        createMjpegFrameSink(canvas, opts.onFrame);
      if (cancelled) {
        sink.close();
        throw new ExportCancelledError();
      }

      const proceed = await opts.beginExport({
        durationSecs: totalMs / 1000,
        audioWavBytes,
        frameFormat: sink.frameFormat,
        sourceWidth: sink.sourceWidth,
        sourceHeight: sink.sourceHeight,
      });
      if (!proceed || cancelled) {
        sink.close();
        throw new ExportCancelledError();
      }

      isExportingRef.current = true;
      // Both videos get played forward (sped up) during capture — audio is already fully
      // rendered separately by this point (see above) and never needed from these
      // elements directly, so mute them for the duration regardless of the live Mute
      // toggle, or an unmuted export would blast sped-up audio out the speakers.
      const origScreenMuted = screenVideo.muted;
      const origCameraMuted = cameraVideo?.muted;
      screenVideo.muted = true;
      if (cameraVideo) cameraVideo.muted = true;
      try {
        const frameDurationMs = 1000 / opts.fps;
        const totalFrames = Math.max(1, Math.round((totalMs / 1000) * opts.fps));
        const breakpoints = exportSegmentBreaks(totalMs, clips, cameraClips);

        let screenClipId: string | null = null;
        let cameraClipId: string | null = null;
        let screenClip: TimelineClip | null = null;
        let cameraClip: TimelineClip | null = null;
        let segIdx = 0;
        // Per-export, per-element "this is as far as it decodes" record — see
        // waitUntilSourceTime, which both fills and consults it. Deliberately not hoisted
        // out of this export run: it's an observation about how a particular element
        // behaved just now, not a durable fact about the file.
        const reachableEndSec = new Map<HTMLVideoElement, number>();

        // Per-phase wall-clock totals, logged once at the end (see the summary below).
        // Cheap enough to leave in permanently — four performance.now() reads per frame —
        // and it's what turns "export felt slow" into a number pointing at a phase,
        // without having to re-derive the whole pipeline's cost breakdown by hand.
        const phaseMs = { wait: 0, draw: 0, encode: 0 };
        const loopStartedAt = performance.now();

        for (let i = 0; i < totalFrames && !cancelled; i++) {
          const targetMs = Math.min(totalMs, i * frameDurationMs);
          while (segIdx < breakpoints.length - 2 && targetMs >= breakpoints[segIdx + 1]) segIdx++;

          // Entering a new segment — re-resolve each track and, only for whichever one's
          // resolved clip actually changed, seek it once; a track whose clip is unchanged
          // from the previous segment is left alone, still wherever it already got to.
          // Not (re)started playing here — waitUntilSourceTime below is what actually
          // calls play(), and only when the frozen/just-seeked position doesn't already
          // satisfy this exact frame's target, so a seek that happens to land exactly on
          // (or past) what's needed doesn't get an immediately-pointless play() call.
          const segStart = breakpoints[segIdx];
          const screenResolved = resolveClipAt(clips, segStart);
          const cameraResolved = resolveClipAt(cameraClips, segStart);
          if ((screenResolved?.clip.id ?? null) !== screenClipId) {
            screenClipId = screenResolved?.clip.id ?? null;
            screenClip = screenResolved?.clip ?? null;
            if (screenResolved) {
              await seekAndWait(screenVideo, screenResolved.sourceMs / 1000);
              if (cancelled) break;
              screenVideo.playbackRate = MAX_EXPORT_PLAYBACK_RATE;
            } else {
              screenVideo.pause();
            }
          }
          if ((cameraResolved?.clip.id ?? null) !== cameraClipId) {
            cameraClipId = cameraResolved?.clip.id ?? null;
            cameraClip = cameraResolved?.clip ?? null;
            if (cameraVideo) {
              if (cameraResolved) {
                await seekAndWait(cameraVideo, cameraResolved.sourceMs / 1000);
                if (cancelled) break;
                cameraVideo.playbackRate = MAX_EXPORT_PLAYBACK_RATE;
              } else {
                cameraVideo.pause();
              }
            }
          }

          // Resuming (if needed at all) is now waitUntilSourceTime's own call — it only
          // actually plays a track when the frozen position doesn't already satisfy this
          // frame's target, rather than unconditionally every frame (see its own comment).
          const waits: Promise<void>[] = [];
          if (screenClip) {
            waits.push(waitUntilSourceTime(screenVideo, (screenClip.sourceStart + (targetMs - screenClip.timelineStart)) / 1000, reachableEndSec));
          }
          if (cameraClip && cameraVideo) {
            waits.push(
              waitUntilSourceTime(cameraVideo, (cameraClip.sourceStart + (targetMs - cameraClip.timelineStart)) / 1000, reachableEndSec)
            );
          }
          const waitStartedAt = performance.now();
          if (waits.length > 0) await Promise.all(waits);
          phaseMs.wait += performance.now() - waitStartedAt;
          // Freeze both tracks the instant this frame's target is reached — everything
          // from here down (draw, JPEG-encode, the IPC round trip to hand the frame off)
          // takes real wall-clock time, and a *playing* video keeps advancing through all
          // of it. Nothing paced that against real time (this loop deliberately doesn't
          // run at 1x), so real, uncut source content kept racing ahead of the frame
          // sequence meant to represent it — compressing footage that should span the
          // full export into however many frames the video took to outrun this loop, most
          // visibly seen as every click's ripple/sound bunching up in the first couple of
          // output seconds instead of landing at its actual recorded timestamp.
          screenVideo.pause();
          cameraVideo?.pause();
          if (cancelled) break;

          editedMsRef.current = targetMs;
          activeClipIdRef.current = screenClipId;
          activeCameraClipIdRef.current = cameraClipId;
          const drawStartedAt = performance.now();
          drawFrameRef.current?.();
          phaseMs.draw += performance.now() - drawStartedAt;

          const encodeStartedAt = performance.now();
          await sink.submit(i);
          phaseMs.encode += performance.now() - encodeStartedAt;
          if (cancelled) break;
          opts.onProgress?.(i / totalFrames);
        }
        screenVideo.pause();
        cameraVideo?.pause();

        if (cancelled) throw new ExportCancelledError();
        // Drains whatever the encoder and the IPC chain still hold — on the h264 path the
        // loop above deliberately runs ahead of both, so frames are still in flight here.
        const flushStartedAt = performance.now();
        await sink.finish();
        const flushMs = performance.now() - flushStartedAt;

        const loopMs = performance.now() - loopStartedAt;
        const per = (ms: number) => (ms / Math.max(1, totalFrames)).toFixed(1);
        console.info(
          `[export] ${sink.frameFormat} ${sink.sourceWidth}x${sink.sourceHeight}@${opts.fps} ` +
            `frames=${totalFrames} total=${(loopMs / 1000).toFixed(1)}s ` +
            `(${(loopMs / Math.max(1, totalMs)).toFixed(2)}x realtime) — per frame: ` +
            `wait ${per(phaseMs.wait)}ms, draw ${per(phaseMs.draw)}ms, encode ${per(phaseMs.encode)}ms, ` +
            `flush ${(flushMs / 1000).toFixed(1)}s total`
        );
        opts.onProgress?.(1);
      } finally {
        sink.close();
        isExportingRef.current = false;
        screenVideo.pause();
        screenVideo.playbackRate = 1;
        screenVideo.muted = origScreenMuted;
        if (cameraVideo) {
          cameraVideo.pause();
          cameraVideo.playbackRate = 1;
          cameraVideo.muted = origCameraMuted ?? cameraVideo.muted;
        }
        // The draw-loop effect's own rAF self-scheduling stood down for the duration of
        // the capture (see draw()'s isExportingRef guard) — kick it back into motion now
        // that live preview is in charge of this canvas again.
        if (drawFrameRef.current) rafRef.current = requestAnimationFrame(drawFrameRef.current);
      }
    })();

    return { promise, cancel };
  }

  useImperativeHandle(ref, () => ({
    seekMs(ms: number) {
      seekToEditedMs(ms);
    },
    togglePlay() {
      togglePlay();
    },
    exportVideo(opts: {
      fps: number;
      width: number;
      height: number;
      onProgress?: (fraction: number) => void;
      decodeAudio: (filePath: string) => Promise<ArrayBuffer>;
      beginExport: (info: {
        durationSecs: number;
        audioWavBytes: ArrayBuffer | null;
        frameFormat: "h264" | "mjpeg";
        sourceWidth: number;
        sourceHeight: number;
      }) => Promise<boolean>;
      onFrame: (frameBytes: ArrayBuffer) => Promise<void>;
    }) {
      return exportVideo(opts);
    },
  }));

  // Maps a pointer event's client coords into the canvas's own pixel space, undoing the
  // letterboxing `object-fit: contain` introduces when the canvas's internal resolution
  // doesn't match its displayed CSS box.
  function canvasPoint(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || canvas.width === 0 || canvas.height === 0) return null;
    const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    const offX = (rect.width - canvas.width * scale) / 2;
    const offY = (rect.height - canvas.height * scale) / 2;
    return { x: (e.clientX - rect.left - offX) / scale, y: (e.clientY - rect.top - offY) / scale };
  }

  // CSS px of the canvas's displayed box per one of its own internal pixels — e.g. reel's
  // portrait canvas (1080x1920) crams far more internal pixels behind the same on-screen
  // frame size than landscape's (1920x1080) does, so a snap tolerance defined as a flat
  // fraction of canvas size feels (and is) far tighter on screen for reel. Converting a
  // fixed on-screen pixel radius through this scale keeps the actual felt snap zone
  // consistent across formats.
  function canvasDisplayScale(canvas: HTMLCanvasElement): number {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || canvas.width === 0 || canvas.height === 0) return 1;
    return Math.min(rect.width / canvas.width, rect.height / canvas.height);
  }

  type Hit = { kind: "camera" | "screen"; action: "resize"; corner: Corner } | { kind: "camera" | "screen"; action: "move" };

  // Resize handles take priority over the body-drag hit test — they're small, so a
  // near-corner grab should always resize rather than move.
  function hitTest(pt: { x: number; y: number }, info: (typeof interactionRef)["current"]): Hit | null {
    if (info.cameraResizeHandles) {
      for (const corner of CORNERS) {
        if (pointInRect(pt.x, pt.y, info.cameraResizeHandles[corner])) return { kind: "camera", action: "resize", corner };
      }
    }
    if (info.cameraRect && info.cameraDrag && pointInRect(pt.x, pt.y, info.cameraRect)) return { kind: "camera", action: "move" };
    for (const corner of CORNERS) {
      if (pointInRect(pt.x, pt.y, info.screenResizeHandles[corner])) return { kind: "screen", action: "resize", corner };
    }
    if (info.screenDrag && pointInRect(pt.x, pt.y, info.screenRect)) return { kind: "screen", action: "move" };
    return null;
  }

  // "tl"/"br" corners resize along the same diagonal as a nwse cursor; "tr"/"bl" along nesw.
  function resizeCursor(corner: Corner): string {
    return corner === "tl" || corner === "br" ? "nwse-resize" : "nesw-resize";
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === "cut") return; // the cut tool only ever splits on click — never drags a box
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pt = canvasPoint(canvas, e);
    if (!pt) return;
    const info = interactionRef.current;
    const hit = hitTest(pt, info);
    if (!hit) return; // not a draggable box/handle here — let the click-to-play handler run

    const { kind } = hit;
    if (hit.action === "resize") {
      const box = kind === "camera" ? info.cameraRect : info.screenRect;
      if (!box) return;
      // anchorX/Y is the corner *opposite* the one grabbed — it stays fixed while that
      // corner (and the box's other two edges) follow the pointer.
      const anchorX = hit.corner === "tl" || hit.corner === "bl" ? box.x + box.w : box.x;
      const anchorY = hit.corner === "tl" || hit.corner === "tr" ? box.y + box.h : box.y;
      dragStateRef.current = { mode: "resize", target: kind, corner: hit.corner, anchorX, anchorY, startClientX: e.clientX, startClientY: e.clientY };
    } else if (kind === "screen" && layoutRef.current.reelScreenFull) {
      // Full-bleed — drag pans the crop instead of moving the box (see dragStateRef's
      // "pan" mode and the draw()/drawScreenContent side of this).
      const screenVideo = screenVideoRef.current;
      if (!screenVideo || !info.screenRect) return;
      const m = computeScreenContentFit(info.screenRect, backgroundRef.current, screenVideo, "cover");
      const pos = layoutRef.current.freeScreenPos;
      const drawX = m.contentX + pctToOffset(pos?.xPct ?? 50, m.contentW - m.fitW);
      const drawY = m.contentY + pctToOffset(pos?.yPct ?? 50, m.contentH - m.fitH);
      dragStateRef.current = { mode: "pan", grabDX: pt.x - drawX, grabDY: pt.y - drawY, startClientX: e.clientX, startClientY: e.clientY };
    } else {
      const box = kind === "camera" ? info.cameraRect : info.screenRect;
      const region = kind === "camera" ? info.cameraDrag : info.screenDrag;
      if (!box || !region) return;
      // Grabbing the screen while it's still derived (split, "nothing set" — see
      // buildSplitSlots) is the moment control hands back to the user. A move alone
      // doesn't otherwise touch size, so without capturing it here, its stored
      // freeScreenSizePct/HeightPct (stale, e.g. still 100/100 from a fresh project) would
      // apply the instant freeScreenPos goes non-null — sizing it to whatever it actually
      // is right now keeps that handoff seamless instead of snapping to full-canvas.
      const capturedSize: { freeScreenSizePct: number; freeScreenHeightPct: number } | undefined =
        kind === "screen" && layoutRef.current.freeScreenPos === null
          ? { freeScreenSizePct: (box.w / info.canvasW) * 100, freeScreenHeightPct: (box.h / info.canvasH) * 100 }
          : undefined;
      dragStateRef.current = {
        mode: "move",
        target: kind,
        region,
        grabDX: pt.x - box.x,
        grabDY: pt.y - box.y,
        startClientX: e.clientX,
        startClientY: e.clientY,
        capturedSize,
      };
    }
    didDragRef.current = false;
    guideRef.current = { v: [], h: [] };
    canvas.style.cursor = hit.action === "resize" ? resizeCursor(hit.corner) : "grabbing";
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const drag = dragStateRef.current;
    if (!canvas) return;
    if (!drag) {
      // Not dragging — just update the hover cursor.
      if (tool === "cut") {
        canvas.style.cursor = "crosshair";
        return;
      }
      const pt = canvasPoint(canvas, e);
      const hit = pt ? hitTest(pt, interactionRef.current) : null;
      canvas.style.cursor = hit?.action === "resize" ? resizeCursor(hit.corner) : hit ? "grab" : "pointer";
      return;
    }
    const pt = canvasPoint(canvas, e);
    if (!pt) return;
    // A pointerdown+up with no real movement should still toggle play, not be swallowed
    // as an accidental drag — only flag (and act on) this as a drag past a small threshold.
    // Measured in client (CSS) pixels, not canvas pixels, so it's consistent regardless
    // of how much the canvas's internal resolution differs from its displayed size.
    if (!didDragRef.current) {
      const moved = Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY);
      if (moved < DRAG_MOVE_THRESHOLD_PX) return;
      didDragRef.current = true;
    }

    if (drag.mode === "pan") {
      const screenVideo = screenVideoRef.current;
      const box = interactionRef.current.screenRect;
      if (!screenVideo || !box) return;
      const m = computeScreenContentFit(box, backgroundRef.current, screenVideo, "cover");
      const rangeX = m.contentW - m.fitW; // <=0 — how far the crop can pan on this axis, 0 if it isn't cropped here at all
      const rangeY = m.contentH - m.fitH;
      // Clamped strictly within the crop's own valid range (unlike a normal move) — panning
      // past either end would start revealing blank background, which the crop exists to
      // avoid in the first place.
      const rawDrawX = pt.x - drag.grabDX;
      const rawDrawY = pt.y - drag.grabDY;
      const offsetX = Math.max(rangeX, Math.min(0, rawDrawX - m.contentX));
      const offsetY = Math.max(rangeY, Math.min(0, rawDrawY - m.contentY));
      const xPct = offsetToPct(offsetX, rangeX);
      const yPct = offsetToPct(offsetY, rangeY);
      onLayoutChangeRef.current({ ...layoutRef.current, freeScreenPos: { xPct, yPct } });
      return;
    }

    if (drag.mode === "resize") {
      const canvasW = interactionRef.current.canvasW;
      const canvasH = interactionRef.current.canvasH;
      // The box resizes from a fixed corner (drag.anchorX/Y — the opposite one from
      // whichever was grabbed, see handlePointerDown) — the grabbed corner is free to
      // travel past the canvas's own edge on that side, stretching the box out of frame
      // rather than being capped at it (only a floor, so it can't shrink to nothing).
      const rawW = pt.x - drag.anchorX;
      const rawH = pt.y - drag.anchorY;
      const desiredW = Math.max(20, Math.abs(rawW));
      const desiredH = Math.max(20, Math.abs(rawH));
      const shorterC = Math.min(canvasW, canvasH);
      const snapPx = SNAP_SCREEN_PX / canvasDisplayScale(canvas);
      const vGuides: number[] = [];
      const hGuides: number[] = [];

      if (drag.target === "screen") {
        // A true free rectangle — width and height set independently, straight from the
        // pointer deltas, so (unlike the camera bubble below) there's no shape transform
        // between them and what's actually rendered, and the boundary check can just use
        // the actual (post-floor) dimensions directly.
        const sizePct = Math.max(10, (desiredW / canvasW) * 100);
        const heightPct = Math.max(10, (desiredH / canvasH) * 100);
        const actualW = (sizePct / 100) * canvasW;
        const actualH = (heightPct / 100) * canvasH;
        const boxX = rawW >= 0 ? drag.anchorX : drag.anchorX - actualW;
        const boxY = rawH >= 0 ? drag.anchorY : drag.anchorY - actualH;
        if (Math.abs(boxX) < snapPx) vGuides.push(0);
        if (Math.abs(boxX + actualW - canvasW) < snapPx) vGuides.push(1);
        if (Math.abs(boxY) < snapPx) hGuides.push(0);
        if (Math.abs(boxY + actualH - canvasH) < snapPx) hGuides.push(1);
        guideRef.current = { v: vGuides, h: hGuides };
        // While reelScreenFull, freeScreenPos is the pan offset (see the "pan" drag mode
        // above), not a box position — leave it untouched here, or resizing would
        // clobber whatever crop the user had panned to with a position value instead.
        const next = { ...layoutRef.current, freeScreenSizePct: sizePct, freeScreenHeightPct: heightPct };
        if (!layoutRef.current.reelScreenFull) {
          next.freeScreenPos = { xPct: offsetToPct(boxX, canvasW - actualW), yPct: offsetToPct(boxY, canvasH - actualH) };
        }
        onLayoutChangeRef.current(next);
      } else {
        // Same idea for the camera bubble — draggable well past the Camera tab slider's
        // own 45% ceiling, past even the canvas's own shorter dimension. sizeFromBubbleDims
        // collapses desiredW/desiredH into one scalar (e.g. round/square use whichever is
        // smaller), so — same reasoning as screen above — the boundary check (and the
        // anchor-relative position below) needs the *actual* committed width/height that
        // scalar resolves back to, not the raw deltas.
        const cam = cameraRef.current;
        const size = sizeFromBubbleDims(cam.shape, desiredW, desiredH);
        const sizePct = Math.max(10, (size / shorterC) * 100);
        const actual = bubbleDimensions(cam.shape, (sizePct / 100) * shorterC);
        const boxX = rawW >= 0 ? drag.anchorX : drag.anchorX - actual.width;
        const boxY = rawH >= 0 ? drag.anchorY : drag.anchorY - actual.height;
        if (Math.abs(boxX) < snapPx) vGuides.push(0);
        if (Math.abs(boxX + actual.width - canvasW) < snapPx) vGuides.push(1);
        if (Math.abs(boxY) < snapPx) hGuides.push(0);
        if (Math.abs(boxY + actual.height - canvasH) < snapPx) hGuides.push(1);
        guideRef.current = { v: vGuides, h: hGuides };
        const xPct = offsetToPct(boxX, canvasW - actual.width);
        const yPct = offsetToPct(boxY, canvasH - actual.height);
        onCameraChangeRef.current({ ...cam, sizePct: Math.round(sizePct) });
        onLayoutChangeRef.current({ ...layoutRef.current, freeCameraPos: { xPct, yPct } });
      }
      return;
    }

    const { region } = drag;
    let desiredX = pt.x - drag.grabDX;
    let desiredY = pt.y - drag.grabDY;

    // Free-drag can push the box out of the canvas — cut off by its own edge, same as a
    // layer dragged past a frame in any editor — down to fully off either side, not just
    // confined within bounds.
    desiredX = Math.max(-region.boxW, Math.min(canvas.width, desiredX));
    desiredY = Math.max(-region.boxH, Math.min(canvas.height, desiredY));

    const snapPx = SNAP_SCREEN_PX / canvasDisplayScale(canvas);
    const boxCenterX = desiredX + region.boxW / 2;
    const boxCenterY = desiredY + region.boxH / 2;
    const vGuides: number[] = [];
    const hGuides: number[] = [];
    for (const f of GUIDE_FRACTIONS) {
      const targetX = canvas.width * f;
      if (Math.abs(boxCenterX - targetX) < snapPx) {
        desiredX = targetX - region.boxW / 2;
        vGuides.push(f);
      }
      const targetY = canvas.height * f;
      if (Math.abs(boxCenterY - targetY) < snapPx) {
        desiredY = targetY - region.boxH / 2;
        hGuides.push(f);
      }
    }
    // Boundary-touch guides — snap flush the instant the box's own edge (not its center,
    // like the fractional guides above) nears a canvas edge, so there's a clear line the
    // moment it touches before the user drags it on past and out of frame.
    if (Math.abs(desiredX) < snapPx) {
      desiredX = 0;
      vGuides.push(0);
    }
    if (Math.abs(desiredX + region.boxW - canvas.width) < snapPx) {
      desiredX = canvas.width - region.boxW;
      vGuides.push(1);
    }
    if (Math.abs(desiredY) < snapPx) {
      desiredY = 0;
      hGuides.push(0);
    }
    if (Math.abs(desiredY + region.boxH - canvas.height) < snapPx) {
      desiredY = canvas.height - region.boxH;
      hGuides.push(1);
    }
    guideRef.current = { v: vGuides, h: hGuides };

    const xPct = offsetToPct(desiredX - region.originX, region.travelW);
    const yPct = offsetToPct(desiredY - region.originY, region.travelH);

    const current = layoutRef.current;
    if (drag.target === "camera") {
      onLayoutChangeRef.current({ ...current, freeCameraPos: { xPct, yPct } });
    } else {
      // capturedSize (only ever set once, at grab, exiting split-derivation) is folded in
      // explicitly on every move event rather than left for layoutRef to pick up on its
      // own — that ref lags a render or two behind onLayoutChangeRef's last call, so
      // spreading {...current} here would otherwise still see the pre-capture 100%/100%
      // and silently restore it.
      onLayoutChangeRef.current({ ...current, ...drag.capturedSize, freeScreenPos: { xPct, yPct } });
    }
  }

  function handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    dragStateRef.current = null;
    guideRef.current = { v: [], h: [] };
    if (canvas) {
      canvas.style.cursor = "pointer";
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    }
  }

  // Cut tool — splits whichever clip is under the current (raw source-time) playhead into
  // two, at that point.
  function cutAtPlayhead() {
    const screenVideo = screenVideoRef.current;
    if (!screenVideo || !screenVideo.duration) return;
    const sourceMs = screenVideo.currentTime * 1000;
    const sourceDurationMs = screenVideo.duration * 1000;
    // Same default-clip shape as the draw loop (see its own comment) — otherwise a cut on
    // an unedited Clips track could split at a boundary that doesn't match what's actually
    // shown/playing.
    const cameraSourceDurationMs = cameraDurationMsRef.current ?? sourceDurationMs;
    const offsetMs = sideClipOffsetMsRef.current;
    const alignedLengthMs = Math.min(Math.max(0, sourceDurationMs - offsetMs), cameraSourceDurationMs);
    const clips = effectiveClips(timelineRef.current.clips, sourceDurationMs, 0, alignedLengthMs, offsetMs);
    onTimelineChangeRef.current({ ...timelineRef.current, clips: splitClipAtSource(clips, sourceMs) });
  }

  function handleCanvasClick() {
    // A drag that actually moved shouldn't also toggle playback on release.
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    if (tool === "cut") {
      cutAtPlayhead();
      return;
    }
    togglePlay();
  }

  return (
    <div className="preview-compositor">
      <div className="preview-canvas-frame">
        <div className="preview-canvas-aspect" style={{ aspectRatio: `${canvasSize.w} / ${canvasSize.h}` }}>
          <canvas
            ref={canvasRef}
            className="preview-canvas"
            onClick={handleCanvasClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
        </div>
      </div>
      <div className="preview-controls">
        <button type="button" className="preview-play-btn" onClick={togglePlay} title={`${playing ? "Pause" : "Play"} (Space)`}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={progress}
          onChange={(e) => seekTo(Number(e.target.value))}
          className="preview-scrub"
        />
        <span className="preview-time">
          {formatTime(progress * duration)} / {formatTime(duration)}
        </span>
        <button
          type="button"
          className="preview-mute-btn"
          aria-pressed={sound.muted}
          title={sound.muted ? "Unmute" : "Mute"}
          onClick={() => onSoundChange({ ...sound, muted: !sound.muted })}
        >
          {sound.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
        </button>
        {(onUndo || onRedo) && (
          <div className="preview-history-group">
            <button
              type="button"
              className="preview-history-btn"
              disabled={!canUndo}
              title={`Undo (${UNDO_SHORTCUT_LABEL})`}
              onClick={onUndo}
            >
              <Undo2 size={14} />
            </button>
            <button
              type="button"
              className="preview-history-btn"
              disabled={!canRedo}
              title={`Redo (${REDO_SHORTCUT_LABEL})`}
              onClick={onRedo}
            >
              <Redo2 size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
