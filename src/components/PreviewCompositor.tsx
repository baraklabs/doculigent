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
import { effectiveClips, resolveClipAt, splitClipAtSource, totalClipsExtentMs } from "@shared/lib/timelineClips";
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

export interface ExportCaptureResult {
  blob: Blob;
  durationSecs: number;
  width: number;
  height: number;
  hasAudio: boolean;
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
  /** Captures the canvas exactly as shown in the preview — same camera/background/cursor/
   *  zoom/cuts rendering, same audio source the Mute toggle governs — by rewinding to the
   *  start and playing the whole edited timeline through in real time while recording it.
   *  `fps` sets the capture rate; final export resolution/scaling is handled downstream
   *  (see EditPage's export flow), since this always captures at the canvas's own native
   *  pixel size. Returns a cancelable handle rather than a bare promise so a real-time,
   *  potentially long capture can be aborted mid-flight. */
  exportVideo: (opts: {
    fps: number;
    onProgress?: (fraction: number) => void;
  }) => { promise: Promise<ExportCaptureResult>; cancel: () => void };
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

// Shown in place of the pointing hand for a brief moment right after a detected click.
const HAND_GRABBING_REGULAR_PATH = new Path2D(
  "M188,80a27.79,27.79,0,0,0-13.36,3.4,28,28,0,0,0-46.64-11A28,28,0,0,0,80,92v20H68a28,28,0,0,0-28,28v12a88,88,0,0,0,176,0V108A28,28,0,0,0,188,80Zm12,72a72,72,0,0,1-144,0V140a12,12,0,0,1,12-12H80v24a8,8,0,0,0,16,0V92a12,12,0,0,1,24,0v28a8,8,0,0,0,16,0V92a12,12,0,0,1,24,0v28a8,8,0,0,0,16,0V108a12,12,0,0,1,24,0Z"
);
const HAND_GRABBING_FILL_PATH = new Path2D(
  "M216,104v48a88,88,0,0,1-176,0V136a16,16,0,0,1,32,0v8a8,8,0,0,0,16,0V88a16,16,0,0,1,32,0v16a8,8,0,0,0,16,0V88a16,16,0,0,1,32,0v16a8,8,0,0,0,16,0,16,16,0,0,1,32,0Z"
);
const HAND_GRABBING_HOTSPOT = { x: 128, y: 90 }; // center of the closed fist
const GRAB_FLASH_MS = 300; // how long the grabbed-hand pose stays up after a click

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
  startedAt: number; // performance.now() at trigger
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

/** Synthesizes a short click sound in one of a few timbres — no bundled audio asset
 *  needed for any of them. */
function playClickSound(
  audioCtxRef: { current: AudioContext | null },
  style: CursorEditSettings["clickSoundStyle"]
): void {
  try {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    const ctx = audioCtxRef.current;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    if (style === "pop") {
      osc.type = "triangle";
      osc.frequency.setValueAtTime(900, now);
      osc.frequency.exponentialRampToValueAtTime(320, now + 0.09);
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.11);
    } else if (style === "click") {
      osc.type = "square";
      osc.frequency.setValueAtTime(2200, now);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.035);
    } else {
      osc.type = "sine";
      osc.frequency.value = 1200;
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.07);
    }
  } catch {
    // Web Audio unavailable — skip the sound silently.
  }
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
 *  coords) recenters the crop on a point other than the video's own center — used to keep
 *  a timeline zoom block centered on the recorded cursor instead of the screen's middle;
 *  clamped so the crop window never runs off the source video's edge. */
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
  const zoom = Math.max(1, bg.zoomPct / 100);
  const srcW = svW / zoom;
  const srcH = svH / zoom;
  const srcX = focusSrc ? clamp(focusSrc.x - srcW / 2, 0, Math.max(0, svW - srcW)) : (svW - srcW) / 2;
  const srcY = focusSrc ? clamp(focusSrc.y - srcH / 2, 0, Math.max(0, svH - srcH)) : (svH - srcH) / 2;
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
 *  this is actually called from. `focusSrc` — see computeScreenContentFit — recenters
 *  the crop on the recorded cursor's position while a timeline zoom block is active,
 *  instead of the video's own center. */
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

/** Eases from `baselinePct` up to the active zoom block's pct and back down over
 *  ZOOM_TRANSITION_MS at each edge of its window, holding at the target in between —
 *  a trapezoid envelope, not a hard cut in zoom level. */
function computeActiveZoomPct(baselinePct: number, zooms: TimelineZoom[], currentMs: number): number {
  const zoom = findActiveZoom(zooms, currentMs);
  if (!zoom) return baselinePct;
  const half = Math.max(1, zoom.durationMs / 2);
  const transition = Math.min(ZOOM_TRANSITION_MS, half);
  const tIn = Math.min(1, (currentMs - zoom.startMs) / transition);
  const tOut = Math.min(1, (zoom.startMs + zoom.durationMs - currentMs) / transition);
  const envelope = Math.max(0, Math.min(tIn, tOut));
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
  const blurVideoRef = useRef<HTMLVideoElement | null>(null);
  const blurHandleRef = useRef<CameraBlurHandle | null>(null);
  const rafRef = useRef(0);
  const rippleRef = useRef<ClickRipple | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
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
  // Smoothed cursor-follow target (source-video pixel coords) for an active zoom block —
  // eased toward the cursor's raw position each frame (see ZOOM_FOCUS_SMOOTH_MS below)
  // rather than snapping straight to it, so a jump between sparse recorded cursor samples
  // pans instead of jump-cuts. Cleared whenever no zoom is active so the next one starts
  // fresh instead of easing in from wherever the last one left off.
  const zoomFocusRef = useRef<{ x: number; y: number } | null>(null);
  // The user's actual play/pause intent — distinct from screenVideo.paused, which the
  // draw loop itself toggles while passing through a gap.
  const isPlayingRef = useRef(false);
  const lastClickAtRef = useRef(-Infinity); // performance.now() — drives the hand style's brief grab pose

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
  useEffect(() => {
    bgImageRef.current = null;
    if (!backdropImageUrl) return;
    const img = new Image();
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
    lastClickAtRef.current = -Infinity;
    if (!cursorMetadataPath || !cursorIconsDir) return;
    (async () => {
      try {
        const metadata: CursorMetadata = await (await fetch(mediaUrl(cursorMetadataPath))).json();
        const icons = await Promise.all(
          metadata.icons.map(
            (asset) =>
              new Promise<LoadedCursorIcon>((resolve, reject) => {
                const img = new Image();
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

  // Which element actually carries the recorded audio (mic/system, talking, etc.):
  // when there's a separate camera track, screenFilePath is the native gdigrab capture
  // (video-only, ffmpeg only mixes audio into it at export time) and the *camera* track
  // is what was recorded with the live mic/system audio attached — so it, not the screen
  // element, is the one that should ever be unmuted. Without a separate camera track,
  // screenFilePath is already the fully-muxed file and carries the audio itself.
  const mutedRef = useRef(sound.muted);
  useEffect(() => {
    mutedRef.current = sound.muted;
    const audioEl = cameraFilePath ? cameraVideoRef.current : screenVideoRef.current;
    if (audioEl) audioEl.muted = sound.muted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sound.muted, cameraFilePath]);

  // Load the source video(s) whenever the project's media changes.
  useEffect(() => {
    const screenVideo = document.createElement("video");
    screenVideo.src = mediaUrl(screenFilePath);
    screenVideo.muted = cameraFilePath ? true : mutedRef.current;
    screenVideo.playsInline = true;
    screenVideoRef.current = screenVideo;

    let cameraVideo: HTMLVideoElement | null = null;
    if (cameraFilePath) {
      cameraVideo = document.createElement("video");
      cameraVideo.src = mediaUrl(cameraFilePath);
      cameraVideo.muted = mutedRef.current;
      cameraVideo.playsInline = true;
      cameraVideoRef.current = cameraVideo;
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
      screenVideo.pause();
      cameraVideo?.pause();
      screenVideo.removeEventListener("ended", onEnded);
      screenVideoRef.current = null;
      cameraVideoRef.current = null;
      setPlaying(false);
      setProgress(0);
      setDuration(0);
    };
  }, [screenFilePath, cameraFilePath]);

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
      rafRef.current = requestAnimationFrame(draw);
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

      drawBackdrop(ctx, bg, bgImageRef.current, canvas.width, canvas.height);

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
      const clips = effectiveClips(timelineState.clips, sourceDurationMs);
      // Computed up front (rather than down where the Camera track is otherwise resolved
      // below) so its own rightmost edge can extend `totalMs` — a Camera piece dragged/
      // trimmed past the end of the Clips track should grow the overall timeline to fit it,
      // not get silently clipped off the end.
      const cameraClips = effectiveClips(timelineState.cameraClips, sourceDurationMs);
      let currentMs = 0;
      let totalMs = totalClipsExtentMs(cameraClips);
      let showScreenContent = false;
      const now = performance.now();
      const dtMs = Math.max(0, now - lastFrameAtRef.current);
      lastFrameAtRef.current = now;

      if (clips.length > 0) {
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
      onTimeUpdateRef.current?.(currentMs, totalMs, sourceDurationMs);
      setDuration(totalMs / 1000);
      setProgress(totalMs > 0 ? currentMs / totalMs : 0);

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
      const zoomedBg: BackgroundEditSettings = { ...bg, zoomPct: computeActiveZoomPct(bg.zoomPct, timelineState.zooms, currentMs) };

      // Sample the recorded cursor track early (before the crop is computed below) so an
      // active zoom block can center its crop on the cursor's actual position instead of
      // the screen's static center — "zoom into where the action is," not just "zoom into
      // the middle." Hoisted out here (rather than sampled again down in the cursor-draw
      // step) so both share one binary search per frame. `cursorTMs` is source time — the
      // same clock screenVideo.currentTime and the recorded track both run on.
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

      // Raw cursor position, in source-video pixel space, to zoom-focus on this frame —
      // eased toward via zoomFocusRef rather than applied directly (see its declaration).
      let zoomFocusTarget: { x: number; y: number } | null = null;
      if (activeZoom && cursorSample?.pos && track) {
        const frame = frameDimensions(track.metadata);
        const svW = screenVideo.videoWidth;
        const svH = screenVideo.videoHeight;
        zoomFocusTarget = { x: cursorSample.pos.x * (svW / frame.width), y: cursorSample.pos.y * (svH / frame.height) };
      }
      const ZOOM_FOCUS_SMOOTH_MS = 220;
      if (!zoomFocusTarget) {
        zoomFocusRef.current = null;
      } else if (!zoomFocusRef.current) {
        zoomFocusRef.current = zoomFocusTarget;
      } else {
        const alpha = 1 - Math.exp(-dtMs / ZOOM_FOCUS_SMOOTH_MS);
        zoomFocusRef.current = {
          x: zoomFocusRef.current.x + (zoomFocusTarget.x - zoomFocusRef.current.x) * alpha,
          y: zoomFocusRef.current.y + (zoomFocusTarget.y - zoomFocusRef.current.y) * alpha,
        };
      }
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
              // Pointing hand normally, swapping briefly to a closed "grab" fist right
              // after a detected click. The two glyphs' hotspots aren't identical (a
              // fist has no fingertip to anchor to) so the swap shifts slightly — that
              // reads as the hand actually closing around the click point, not a glitch.
              const grabbing = performance.now() - lastClickAtRef.current < GRAB_FLASH_MS;
              const regularPath = grabbing ? HAND_GRABBING_REGULAR_PATH : HAND_POINTING_REGULAR_PATH;
              const fillPath = grabbing ? HAND_GRABBING_FILL_PATH : HAND_POINTING_FILL_PATH;
              const hotspot = grabbing ? HAND_GRABBING_HOTSPOT : HAND_POINTING_HOTSPOT;
              const scale = (r * 2.6) / 256;
              ctx.translate(px, py);
              ctx.scale(scale, scale);
              ctx.translate(-hotspot.x, -hotspot.y);
              ctx.lineJoin = "round";
              // Both Phosphor weights are closed, solid shapes (unlike lucide's open
              // strokes) — "filled" is the bold "fill" weight with a dark backing stroke
              // for contrast against video content; "not filled" is just the lighter
              // "regular" weight filled plainly, matching how phosphoricons.com itself
              // renders that weight (flat fill, no outline).
              if (cur.filled) {
                ctx.strokeStyle = "rgba(0, 0, 0, .45)";
                ctx.lineWidth = 10;
                ctx.stroke(fillPath);
                ctx.fillStyle = cur.color;
                ctx.fill(fillPath);
              } else {
                ctx.fillStyle = cur.color;
                ctx.fill(regularPath);
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
          const clicks = track.metadata.clicks;
          if (clicks && clicks.length > 0 && cursorTMs > lastPlaybackMsRef.current) {
            for (const clickT of clicks) {
              if (clickT > lastPlaybackMsRef.current && clickT <= cursorTMs) {
                lastClickAtRef.current = performance.now();
                if (cur.clickEffect) {
                  rippleRef.current = { startedAt: performance.now(), x: px, y: py, r, style: cur.clickAnimationStyle };
                }
                if (cur.clickSound) playClickSound(audioCtxRef, cur.clickSoundStyle);
              }
            }
          }

          const ripple = rippleRef.current;
          if (ripple) {
            const elapsed = performance.now() - ripple.startedAt;
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

      // Drag/resize affordance — a faint outline plus a handle at each of a box's 4 corners.
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

      // Snap guides (25%/50%/75% of each axis) — drawn only while actively dragging (see onPointerMove).
      const guide = guideRef.current;
      if (guide.v.length > 0 || guide.h.length > 0) {
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
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
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
    const clips = effectiveClips(timelineRef.current.clips, sourceDurationMs);
    const cameraClips = effectiveClips(timelineRef.current.cameraClips, sourceDurationMs);
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

  function pickExportMimeType(): string {
    const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "video/webm";
  }

  // Captures the actual canvas as a real-time recording — the most reliable way to
  // guarantee the export pixel-matches the preview, since it's literally the same canvas
  // element the draw loop above already renders every frame, rather than a second,
  // separately-maintained render path that could drift out of sync with it. Audio is
  // pulled from whichever element the Mute toggle already governs (see mutedRef's own
  // comment) via HTMLMediaElement.captureStream(), not re-mixed through Web Audio.
  function exportVideo(opts: { fps: number; onProgress?: (fraction: number) => void }): {
    promise: Promise<ExportCaptureResult>;
    cancel: () => void;
  } {
    const canvas = canvasRef.current;
    const screenVideo = screenVideoRef.current;
    if (!canvas || !screenVideo || !screenVideo.duration) {
      return { promise: Promise.reject(new Error("Preview isn't ready yet.")), cancel: () => {} };
    }

    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };

    const promise = (async (): Promise<ExportCaptureResult> => {
      const cameraVideo = cameraVideoRef.current;
      screenVideo.pause();
      cameraVideo?.pause();
      isPlayingRef.current = false;
      setPlaying(false);
      seekToEditedMs(0);
      // Let the draw loop settle on the rewound position for a couple of frames before
      // capture starts, so the recording's first frame isn't whatever was on screen right
      // before the seek.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (cancelled) throw new ExportCancelledError();

      const sourceDurationMs = screenVideo.duration * 1000;
      const clips = effectiveClips(timelineRef.current.clips, sourceDurationMs);
      const cameraClips = effectiveClips(timelineRef.current.cameraClips, sourceDurationMs);
      const totalMs = Math.max(totalClipsExtentMs(clips), totalClipsExtentMs(cameraClips));
      if (totalMs <= 0) throw new Error("There's nothing on the timeline to export.");

      const canvasStream = canvas.captureStream(opts.fps);
      // Same source the Mute toggle already governs (see mutedRef's declaration above) —
      // whichever element actually carries the recorded audio.
      const audioSource = (cameraFilePath ? cameraVideo : screenVideo) as
        | (HTMLVideoElement & { captureStream?: () => MediaStream })
        | null;
      const hasAudio = !mutedRef.current && !!audioSource?.captureStream;
      const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];
      if (hasAudio && audioSource?.captureStream) tracks.push(...audioSource.captureStream().getAudioTracks());

      const recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType: pickExportMimeType(),
        videoBitsPerSecond: 16_000_000,
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      const stopped = new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
      });

      // Piggybacks on the draw loop's own per-frame time callback (rather than polling)
      // to both report progress and detect "reached the end" — the same condition the
      // loop itself uses to stop playback at the end of the timeline (see its own
      // `editedMsRef.current >= totalMs` check).
      const previousOnTimeUpdate = onTimeUpdateRef.current;
      let reachedEnd = false;
      onTimeUpdateRef.current = (currentMs, durationMs, srcDurationMs) => {
        previousOnTimeUpdate?.(currentMs, durationMs, srcDurationMs);
        opts.onProgress?.(durationMs > 0 ? Math.min(1, currentMs / durationMs) : 0);
        if (durationMs > 0 && currentMs >= durationMs - 1 && !isPlayingRef.current) reachedEnd = true;
      };

      recorder.start(250);
      isPlayingRef.current = true;
      setPlaying(true);
      if (activeClipIdRef.current !== null) screenVideo.play().catch(() => {});
      if (activeCameraClipIdRef.current !== null) cameraVideo?.play().catch(() => {});

      try {
        await new Promise<void>((resolve) => {
          const tick = () => {
            if (cancelled || reachedEnd) {
              resolve();
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        });
      } finally {
        onTimeUpdateRef.current = previousOnTimeUpdate;
      }

      screenVideo.pause();
      cameraVideo?.pause();
      isPlayingRef.current = false;
      setPlaying(false);

      if (recorder.state !== "inactive") recorder.stop();
      const blob = await stopped;
      canvasStream.getTracks().forEach((t) => t.stop());

      if (cancelled) throw new ExportCancelledError();
      return { blob, durationSecs: totalMs / 1000, width: canvas.width, height: canvas.height, hasAudio };
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
    exportVideo(opts: { fps: number; onProgress?: (fraction: number) => void }) {
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
    const clips = effectiveClips(timelineRef.current.clips, screenVideo.duration * 1000);
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
