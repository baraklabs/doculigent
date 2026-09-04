import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Pause, Play, Redo2, Undo2 } from "lucide-react";
import {
  BACKGROUND_COLORS,
  BACKGROUND_GRADIENTS,
  DEFAULT_EXT_VIDEO_EDIT_SETTINGS,
  ZOOM_TRANSITION_MS,
  type BackgroundEditSettings,
  type BackgroundGradientPreset,
  type CameraEditSettings,
  type CursorEditSettings,
  type CursorMetadata,
  type EditProjectMediaItem,
  type ExtVideoEditSettings,
  type LayoutEditSettings,
  type TimelineEditSettings,
  type TimelineEffect,
  type TimelineEffectBox,
  type TimelineZoom,
  type TimelineZoomTilt,
} from "@shared/types/models";
import { frameDimensions, toFrameCoords } from "@shared/lib/cursorFrame";
import { effectiveClips, resolveClipAt, sourceToEditedMs, splitClipAtSource, totalClipsExtentMs } from "@shared/lib/timelineClips";
import { resolveSegmentSettings } from "@shared/lib/timelineSegments";
import { EFFECT_POPUP_MS, boxFromCorners, isEffectActiveAt, updateEffect } from "@shared/lib/timelineEffects";
import type { TimelineClip, TimelineMediaClip } from "@shared/types/models";
import { mediaUrl } from "@shared/constants/media";
import { BACKGROUND_IMAGE_URLS, BACKGROUND_TEXTURE_URLS } from "../assets/backgrounds";
import { applyCameraBlur, startCameraSegmentation, type CameraBlurHandle, type CameraSegmentationHandle } from "../services/camera/cameraBlur";
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
  /** The project's added-media pool (EditProject.media) — every file the Timeline's
   *  Video/Audio tracks can place a piece of. One hidden playback element is kept per item
   *  (see mediaElsRef); a piece whose item isn't here simply plays nothing. */
  mediaItems: EditProjectMediaItem[];
  camera: CameraEditSettings;
  onCameraChange: (next: CameraEditSettings) => void;
  background: BackgroundEditSettings;
  cursor: CursorEditSettings;
  layout: LayoutEditSettings;
  onLayoutChange: (next: LayoutEditSettings) => void;
  timeline: TimelineEditSettings;
  onTimelineChange: (next: TimelineEditSettings) => void;
  /** Effects tab (callout/blur boxes) — which box is selected, i.e. the one drawn with grab
   *  handles here. Clicking a box on the canvas selects it, which is what this reports back.
   *  Every *edit* a preview drag makes goes through onTimelineChange like any other, since
   *  the boxes themselves live in `timeline.effects`. */
  activeEffectId?: string | null;
  onActiveEffectChange?: (id: string | null) => void;
  /** Controlled from EditPage — the same Default/Cut toggle rendered in the Timeline
   *  component's ruler row governs what clicking this canvas does. */
  tool: TimelineTool;
  /** Fired every animation frame with the resolved playhead/duration (ms) — drives the
   *  Timeline component's ruler and playhead without it needing its own video element.
   *  `sourceDurationMs` is the raw recording's own length — distinct from `durationMs`
   *  (the edited timeline's extent) once clips have been trimmed, moved, or overlapped —
   *  and is how far a clip's trim handles can reveal hidden footage back out to. */
  /** `alignedFootageLengthMs` is how long the recording's *own* footage runs on the edited
   *  timeline — the shorter of what's left of the screen file once its camera-less lead-in
   *  is trimmed and how much camera footage actually exists (see the draw loop's
   *  alignedLengthMs). Reported because only this component can know it: the camera file's
   *  real duration has to be read off a loaded `<video>` element, and the Timeline has none.
   *  Without it the Timeline draws both footage tracks' default pieces running to the screen
   *  recording's full length while playback stops at the camera's — a mismatch invisible
   *  while that was also the end of the timeline (everything simply clamped to full width),
   *  but plainly wrong the moment an Ext Video/Ext Audio piece extends past it and the
   *  footage pieces stop clamping. */
  onTimeUpdate?: (
    currentMs: number,
    durationMs: number,
    sourceDurationMs: number,
    alignedFootageLengthMs: number
  ) => void;
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
/** Paints an added-media Video piece over everything else on the frame — a cover fit
 *  (fills the canvas, cropping whichever axis overflows), because a piece on the Video
 *  track is an *insert*: for the stretch it covers it is what's playing, in place of the
 *  composited recording underneath rather than floating over a corner of it. Deliberately
 *  not positionable, unlike the camera bubble — the Layout tab's boxes describe the
 *  recording's own screen/camera, and an inserted clip is neither. */
/** The Ext Video presentation settings in force for one placed piece — its own override
 *  (TimelineEditSettings.videoClipOverrides) if it has one, else the track's master
 *  (`extVideo`). Both fall back to the shipped default for a project saved before either
 *  field existed, so an old save renders exactly as it always did. */
function extVideoSettingsFor(t: TimelineEditSettings, clipId: string | null): ExtVideoEditSettings {
  const master = t.extVideo ?? DEFAULT_EXT_VIDEO_EDIT_SETTINGS;
  if (!clipId) return master;
  return t.videoClipOverrides?.[clipId] ?? master;
}

/** An Ext Video piece's travel range — built exactly like the screen box's own
 *  (see the draw loop's screenDrag), so the two share resolveDragPos/offsetToPct and
 *  therefore behave identically under a drag, degenerate full-canvas case included. */
function extVideoDragRegion(ext: ExtVideoEditSettings, canvasW: number, canvasH: number): DragRegion {
  const boxW = (ext.sizePct / 100) * canvasW;
  const boxH = (ext.heightPct / 100) * canvasH;
  return { originX: 0, originY: 0, travelW: canvasW - boxW, travelH: canvasH - boxH, boxW, boxH };
}

/** The box an Ext Video piece is drawn into: `sizePct`/`heightPct` of the canvas, placed at
 *  `pos` — or dead center ({50,50}, the same neutral default the screen box uses) while it
 *  has never been dragged. At 100/100 that's the whole frame; above it the box overflows and
 *  is cut off by the frame edge, exactly like a screen box dragged past it. */
function extVideoBox(ext: ExtVideoEditSettings, canvasW: number, canvasH: number): Rect {
  const region = extVideoDragRegion(ext, canvasW, canvasH);
  const origin = resolveDragPos(ext.pos, region, { x: 50, y: 50 });
  return { x: origin.x, y: origin.y, w: region.boxW, h: region.boxH };
}

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

/** Whichever photo a given BackgroundEditSettings' fill actually needs — a curated
 *  texture, a curated image, or the user's own imported one — or null for "color"/
 *  "gradient"/"none", which don't need one. Pure so it can be called for the master
 *  Screen backdrop *and* for any per-clip override (see PreviewCompositor's
 *  ensureBackdropImageLoaded), not just whichever one happens to be the live React prop. */
function backdropImageUrlFor(bg: BackgroundEditSettings): string | null {
  if (bg.fill === "texture") return BACKGROUND_TEXTURE_URLS[bg.textureId] ?? null;
  if (bg.fill === "image") return bg.customImagePath ? mediaUrl(bg.customImagePath) : (BACKGROUND_IMAGE_URLS[bg.imageId] ?? null);
  return null;
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
    // backdropImageUrlFor/PreviewCompositor's ensureBackdropImageLoaded), keyed off
    // textureId/imageId/customImagePath.
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

let cameraCutoutScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

/** A background-removed camera frame can't be composited straight onto the main canvas
 *  with destination-in the way the bubble outline/etc. are drawn elsewhere: the video is
 *  drawn fully opaque first (there's no other way to get its pixels onto a canvas), which
 *  already overwrites whatever screen/backdrop content sat underneath in that same spot —
 *  destination-in afterward can only shrink the *camera* draw's own alpha, it can't bring
 *  back pixel data the canvas no longer has. Worse, a canvas's alpha channel is typically
 *  stored premultiplied, so zeroing alpha over already-opaque camera pixels drags their
 *  RGB toward black too, rather than leaving anything meaningfully "transparent" to see
 *  through — hence a black cutout instead of the screen recording showing through.
 *  The fix is to build the masked cutout on its own scratch canvas (which starts empty
 *  each frame, so destination-in there only ever erases pixels this same draw just put
 *  down, never anything real), then blit the *finished*, already-transparent-where-it-
 *  should-be result onto the main canvas with a normal source-over draw — which correctly
 *  blends over whatever's still intact underneath instead of replacing it. */
function getCameraCutoutScratch(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (!cameraCutoutScratch) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    cameraCutoutScratch = { canvas, ctx };
  }
  const { canvas } = cameraCutoutScratch;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return cameraCutoutScratch;
}

/** Draws the camera as a shaped/sized bubble at an already-resolved origin. Per-side crop
 *  narrows the source feed first, `zoomPct` then crops into the center of what's left —
 *  same idea as the Background tab's screen crop/zoom. `mask`, when `removeBackground` is
 *  on, is the live segmentation alpha (see startCameraSegmentation) — cropped/scaled to
 *  line up with the same source rect as the video, then composited with destination-in so
 *  only the person stays opaque, letting whatever's already painted behind the bubble
 *  (screen recording, backdrop) show through the rest. */
function drawCameraBubbleAt(
  ctx: CanvasRenderingContext2D,
  source: HTMLVideoElement,
  cam: CameraEditSettings,
  x: number,
  y: number,
  width: number,
  height: number,
  mask: HTMLCanvasElement | null
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
  const cropL = (cam.cropLeftPct / 100) * camW;
  const cropR = (cam.cropRightPct / 100) * camW;
  const cropT = (cam.cropTopPct / 100) * camH;
  const cropB = (cam.cropBottomPct / 100) * camH;
  const cropW = Math.max(1, camW - cropL - cropR);
  const cropH = Math.max(1, camH - cropT - cropB);
  const zoom = Math.max(1, cam.zoomPct / 100);
  const srcCropW = cropW / zoom;
  const srcCropH = cropH / zoom;
  const srcCropX = cropL + (cropW - srcCropW) / 2;
  const srcCropY = cropT + (cropH - srcCropH) / 2;
  const scale = Math.max(width / srcCropW, height / srcCropH);
  const drawW = srcCropW * scale;
  const drawH = srcCropH * scale;

  if (cam.removeBackground && mask) {
    // Built on its own scratch canvas — see getCameraCutoutScratch for why this can't be
    // masked directly against the main canvas.
    const scratchW = Math.max(1, Math.round(width));
    const scratchH = Math.max(1, Math.round(height));
    const { canvas: scratch, ctx: scratchCtx } = getCameraCutoutScratch(scratchW, scratchH);
    const localX = (width - drawW) / 2;
    const localY = (height - drawH) / 2;
    scratchCtx.clearRect(0, 0, scratchW, scratchH);
    scratchCtx.drawImage(source, srcCropX, srcCropY, srcCropW, srcCropH, localX, localY, drawW, drawH);
    // mask covers the same full camW x camH frame, just downscaled (see
    // startCameraSegmentation) — its crop rect is the same fractional region, just
    // rescaled to the mask's own smaller dimensions.
    const maskScaleX = mask.width / camW;
    const maskScaleY = mask.height / camH;
    scratchCtx.globalCompositeOperation = "destination-in";
    scratchCtx.drawImage(
      mask,
      srcCropX * maskScaleX,
      srcCropY * maskScaleY,
      srcCropW * maskScaleX,
      srcCropH * maskScaleY,
      localX,
      localY,
      drawW,
      drawH
    );
    scratchCtx.globalCompositeOperation = "source-over";
    ctx.drawImage(scratch, x, y);
  } else {
    ctx.drawImage(source, srcCropX, srcCropY, srcCropW, srcCropH, x + (width - drawW) / 2, y + (height - drawH) / 2, drawW, drawH);
  }
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
  /** Set only while an active "3d"-style zoom block's tilt is actually warping the drawn
   *  content (see drawScreenContent) — maps a point computed in this fit's own flat,
   *  untilted coordinate space (canvas px) through the same perspective projection, so the
   *  cursor overlay (the one thing still positioned from this fit after the warp) can follow
   *  the tilt instead of floating over it. `scale` is the local depth-based scale factor at
   *  that point, for sizing the cursor to match. */
  warpPoint?: (x: number, y: number) => { x: number; y: number; scale: number };
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

// Perspective strength for the 3D zoom style's tilt — the assumed distance (in multiples
// of the tilted plane's own longer side) from the "camera" to the plane. Smaller pulls the
// camera closer, exaggerating the distortion; larger flattens it. Tuned so the Tilt preset
// grid's TILT_PRESET_ANGLE_DEG swatches read as a clear but not cartoonish tilt.
const TILT_PERSPECTIVE_DEPTH_FACTOR = 1.4;
// Mesh resolution for the perspective warp below — coarse enough to stay cheap per frame
// (both live preview and export re-run this every frame a 3D zoom is active), fine enough
// that the per-cell affine approximation of a true 4-point perspective quad (see
// drawTiltedPlane) has no visible faceting at these tilt angles.
const TILT_GRID_COLS = 16;
const TILT_GRID_ROWS = 9;

/** Projects a point on the zoom's tilted plane (normalized -0.5..0.5 across `planeW`/
 *  `planeH`, plane-center-relative) into a 2D offset from that same center — rotate around
 *  the horizontal axis (xDeg) then the vertical one (yDeg), then a simple perspective
 *  divide. `scale` is the resulting depth-based scale factor at that point (1 at the
 *  plane's own resting depth, z=0), returned so a single overlay point (the cursor) can be
 *  sized to match rather than just repositioned. (xDeg, yDeg) = (0, 0) leaves z untouched
 *  at every point, so scale is always exactly 1 and (x, y) exactly (nx*planeW, ny*planeH)
 *  — a flat, untilted zoom, pixel-for-pixel identical to before this existed. */
function project3D(
  nx: number,
  ny: number,
  planeW: number,
  planeH: number,
  xDeg: number,
  yDeg: number
): { x: number; y: number; scale: number } {
  const x = nx * planeW;
  const y = ny * planeH;
  const rx = (xDeg * Math.PI) / 180;
  const ry = (yDeg * Math.PI) / 180;
  const y1 = y * Math.cos(rx);
  const z1 = y * Math.sin(rx);
  const x2 = x * Math.cos(ry) + z1 * Math.sin(ry);
  const z2 = z1 * Math.cos(ry) - x * Math.sin(ry);
  const depth = Math.max(planeW, planeH) * TILT_PERSPECTIVE_DEPTH_FACTOR;
  const scale = depth / (depth - z2);
  return { x: x2 * scale, y: y1 * scale, scale };
}

let tiltScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

/** Same one-scratch-canvas-reused-every-frame pattern as getCameraCutoutScratch above —
 *  avoids allocating (and GC-ing) a whole canvas per frame for as long as a 3D zoom block
 *  stays active. */
function getTiltScratchCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  if (!tiltScratch) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    tiltScratch = { canvas, ctx };
  }
  const { canvas } = tiltScratch;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return tiltScratch;
}

// Adjacent cells below are defined so they share their corner points exactly in
// *continuous* math, but rasterizing each one separately (its own drawImage call, its own
// edge antialiasing) still leaves a hairline of partial-coverage pixels right at every
// shared edge — visible, once dozens of cells tile the whole tilted plane, as a faint grid
// of squares over the content (like a checkerboard). Overdrawing each cell slightly past
// its own edge into its neighbors papers over exactly that hairline; the same overdraw
// bleeding a fraction of a pixel past the plane's own *outer* edge (nothing to seam with
// there) is too small to read as a mismatch against the rounded corners drawn into
// srcCanvas.
const TILT_CELL_BLEED_PX = 1;

/** Warps `srcCanvas` (the screen content already fit/cropped/corner-rounded flat into an
 *  offscreen buffer by drawScreenContent, at its own natural size) onto `ctx` as a
 *  perspective-tilted plane occupying `planeX/planeY/planeW/planeH` at rest — subdivides it
 *  into a TILT_GRID_COLS x TILT_GRID_ROWS grid and draws each cell with its own 3-point
 *  affine transform (source rect -> that cell's 3 projected corners: top-left, top-right,
 *  bottom-left; see TILT_CELL_BLEED_PX above for why each cell then overdraws slightly past
 *  those exact corners). The one approximation is the 4th corner (bottom-right), which a
 *  true 4-point perspective quad would bow slightly from — imperceptible at cells this
 *  small. Returns a function that maps a point in the *original, untilted* content-box
 *  space (what the cursor overlay already computes its position in) through the same
 *  projection, so that overlay can be repositioned to follow the tilt instead of floating
 *  over it. */
function drawTiltedPlane(
  ctx: CanvasRenderingContext2D,
  srcCanvas: HTMLCanvasElement,
  planeX: number,
  planeY: number,
  planeW: number,
  planeH: number,
  tilt: TimelineZoomTilt
): (x: number, y: number) => { x: number; y: number; scale: number } {
  const cx = planeX + planeW / 2;
  const cy = planeY + planeH / 2;

  const project = (nx: number, ny: number) => {
    const p = project3D(nx, ny, planeW, planeH, tilt.xDeg, tilt.yDeg);
    return { x: cx + p.x, y: cy + p.y, scale: p.scale };
  };

  ctx.save();
  for (let row = 0; row < TILT_GRID_ROWS; row++) {
    const ny0 = row / TILT_GRID_ROWS - 0.5;
    const ny1 = (row + 1) / TILT_GRID_ROWS - 0.5;
    const sy = (row / TILT_GRID_ROWS) * planeH;
    const sh = planeH / TILT_GRID_ROWS;
    for (let col = 0; col < TILT_GRID_COLS; col++) {
      const nx0 = col / TILT_GRID_COLS - 0.5;
      const nx1 = (col + 1) / TILT_GRID_COLS - 0.5;
      const sx = (col / TILT_GRID_COLS) * planeW;
      const sw = planeW / TILT_GRID_COLS;

      const tl = project(nx0, ny0);
      const tr = project(nx1, ny0);
      const bl = project(nx0, ny1);

      // The affine matrix mapping this cell's *exact* (unbled) source rect corners
      // (sx,sy) / (sx+sw,sy) / (sx,sy+sh) onto (tl) / (tr) / (bl) — computed before bleed
      // is applied below, so the bleed extends this same mapping outward rather than
      // shifting it.
      const a = (tr.x - tl.x) / sw;
      const b = (tr.y - tl.y) / sw;
      const c = (bl.x - tl.x) / sh;
      const d = (bl.y - tl.y) / sh;
      const e = tl.x - a * sx - c * sy;
      const f = tl.y - b * sx - d * sy;

      const bsx = sx - TILT_CELL_BLEED_PX;
      const bsy = sy - TILT_CELL_BLEED_PX;
      const bsw = sw + TILT_CELL_BLEED_PX * 2;
      const bsh = sh + TILT_CELL_BLEED_PX * 2;

      ctx.setTransform(a, b, c, d, e, f);
      ctx.drawImage(srcCanvas, bsx, bsy, bsw, bsh, bsx, bsy, bsw, bsh);
    }
  }
  ctx.restore();

  return (x: number, y: number) => project((x - planeX) / planeW - 0.5, (y - planeY) / planeH - 0.5);
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
 *  instead of both the video's center *and* instead of recentering onto it. `tilt` — set
 *  only while an active "3d"-style zoom block's eased tilt is non-zero (see the draw
 *  loop's own computeActiveZoomTilt call) — routes the draw through drawTiltedPlane above
 *  instead of a plain drawImage; left null/all-zero everywhere else, which renders exactly
 *  as before. */
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
  focusSrc?: { x: number; y: number } | null,
  tilt?: TimelineZoomTilt | null
): ScreenFit {
  const m = computeScreenContentFit(box, bg, screenVideo, fitMode, focusSrc);
  const screenDrawX = m.contentX + (panPct.x / 100) * (m.contentW - m.fitW);
  const screenDrawY = m.contentY + (panPct.y / 100) * (m.contentH - m.fitH);

  // The "visible" rect — what's actually left on screen once the corner-round clip is
  // applied — differs by fitMode: "cover" clips to the content box itself (the image
  // deliberately overflows it), "contain" clips to the image's own drawn rect (which is
  // never larger than the content box, so it's the tighter of the two there instead).
  const visX = fitMode === "cover" ? m.contentX : screenDrawX;
  const visY = fitMode === "cover" ? m.contentY : screenDrawY;
  const visW = fitMode === "cover" ? m.contentW : m.fitW;
  const visH = fitMode === "cover" ? m.contentH : m.fitH;
  const contentRadius = (bg.cornerRadiusPct / 100) * (Math.min(visW, visH) / 2);

  // Paints the fit/crop/round exactly as before, just parameterized on which context and
  // origin offset to paint into — (ctx, 0, 0) for the plain path below, or an offscreen
  // scratch buffer (translated so the visible rect's own top-left lands at its origin) when
  // a tilt is about to warp the result.
  const paint = (targetCtx: CanvasRenderingContext2D, ox: number, oy: number) => {
    targetCtx.save();
    targetCtx.beginPath();
    roundedRectPath(targetCtx, visX + ox, visY + oy, visW, visH, contentRadius);
    targetCtx.clip();
    targetCtx.drawImage(screenVideo, m.srcX, m.srcY, m.srcW, m.srcH, screenDrawX + ox, screenDrawY + oy, m.fitW, m.fitH);
    targetCtx.restore();
  };

  let warpPoint: ScreenFit["warpPoint"];

  if (showFrame) {
    const hasTilt = !!tilt && (tilt.xDeg !== 0 || tilt.yDeg !== 0);
    if (!hasTilt) {
      paint(ctx, 0, 0);
    } else {
      const { canvas: scratchCanvas, ctx: scratchCtx } = getTiltScratchCanvas(Math.max(1, Math.ceil(visW)), Math.max(1, Math.ceil(visH)));
      scratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
      paint(scratchCtx, -visX, -visY);
      warpPoint = drawTiltedPlane(ctx, scratchCanvas, visX, visY, visW, visH, tilt!);
    }
  }

  return {
    screenDrawX,
    screenDrawY,
    warpPoint,
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

/** The cosine ease-in-out computeActiveZoomPct and computeActiveZoomTilt both ride the
 *  0..1 envelope through — one shared curve so a zoom block's scale and tilt always move
 *  together, never drifting apart into two visibly different speeds. */
function easeZoomEnvelope(envelope: number): number {
  return (1 - Math.cos(envelope * Math.PI)) / 2;
}

/** Eases from `baselinePct` up to the active zoom block's pct and back down over
 *  ZOOM_TRANSITION_MS at each edge of its window, holding at the target in between —
 *  a trapezoid envelope, not a hard cut in zoom level. */
function computeActiveZoomPct(baselinePct: number, zoom: TimelineZoom | null, envelope: number): number {
  if (!zoom) return baselinePct;
  return baselinePct + (zoom.pct - baselinePct) * easeZoomEnvelope(envelope);
}

/** The "3d" style's tilt equivalent of computeActiveZoomPct above — eases from flat (no
 *  tilt has a baseline to return to outside an active block, unlike pct's bg.zoomPct) up to
 *  the zoom's own tilt and back down over the same envelope. A "2d" block (or one with an
 *  all-zero tilt already) returns all-zero either way, so drawScreenContent's hasTilt check
 *  skips the warp path entirely rather than running it for a no-op tilt. */
function computeActiveZoomTilt(zoom: TimelineZoom | null, envelope: number): TimelineZoomTilt {
  if (!zoom || zoom.style !== "3d") return { xDeg: 0, yDeg: 0 };
  const eased = easeZoomEnvelope(envelope);
  return {
    xDeg: zoom.tilt.xDeg * eased,
    yDeg: zoom.tilt.yDeg * eased,
  };
}

// Effects tab (callout / blur boxes) -----------------------------------------------

// Blur/pixelate both work by re-drawing a copy of what's already on the canvas, so they
// need a scratch buffer. Sized to the *region* (plus a bleed margin, see drawBlurEffect)
// rather than the whole canvas — a full 1920x1080 gaussian every frame, for what is
// usually a small box, would be pure waste.
let effectScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
// Pixelate needs a *second*, tiny buffer (the downscaled mosaic, blown back up into the
// one above) — kept module-level for the same reason: allocating either one per frame,
// per box, would churn canvases at 60fps.
let effectPixelScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

function sizedScratch(
  slot: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null,
  w: number,
  h: number
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const scratch = slot ?? (() => {
    const canvas = document.createElement("canvas");
    return { canvas, ctx: canvas.getContext("2d") as CanvasRenderingContext2D };
  })();
  const { canvas, ctx } = scratch;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  // Reset the bits the last caller may have changed — a resize already clears the canvas,
  // but a same-size reuse does not.
  ctx.filter = "none";
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, w, h);
  return scratch;
}

function getEffectScratch(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  effectScratch = sizedScratch(effectScratch, w, h);
  return effectScratch;
}

function getEffectPixelScratch(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  effectPixelScratch = sizedScratch(effectPixelScratch, w, h);
  return effectPixelScratch;
}

/** An effect's stored % box resolved against this frame's canvas. */
function effectRect(effect: TimelineEffect, canvasW: number, canvasH: number): Rect {
  return {
    x: (effect.box.xPct / 100) * canvasW,
    y: (effect.box.yPct / 100) * canvasH,
    w: Math.max(1, (effect.box.wPct / 100) * canvasW),
    h: Math.max(1, (effect.box.hPct / 100) * canvasH),
  };
}

/** Traces an effect's outline onto the *current* path — a rounded rectangle or an ellipse,
 *  per its `shape`. Deliberately doesn't beginPath: the callout's dim needs this shape as
 *  a second subpath punched out of a full-canvas rect (see drawCalloutEffect), so resetting
 *  here would throw that rect away. Every part of an effect shapes itself off this one
 *  function, so the painted edge always lines up exactly with the box the user dragged. */
function traceEffectPath(ctx: CanvasRenderingContext2D, effect: TimelineEffect, r: Rect): void {
  if (effect.shape === "ellipse") {
    // Explicitly opens the subpath at the ellipse's own 0-radian start point — ellipse(),
    // like arc(), would otherwise join itself to whatever point the previous subpath left
    // current (the callout dim traces this straight after a full-canvas rect).
    ctx.moveTo(r.x + r.w, r.y + r.h / 2);
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    return;
  }
  roundedRectPath(ctx, r.x, r.y, r.w, r.h, (effect.cornerPct / 100) * Math.min(r.w, r.h));
}

// Blur strength (0-100) as a fraction of the canvas's shorter side — 100% lands at ~3.5%
// of it (roughly 38px on a 1080-tall canvas), well past the point where body text stops
// being readable, with the low end still soft enough to blur without obliterating.
const MAX_EFFECT_BLUR_FRACTION = 0.035;
// Pixelate's block size at 100%, against the same reference. Smaller than the blur radius
// because blocks destroy detail far more aggressively at equal size.
const MAX_EFFECT_PIXEL_FRACTION = 0.022;

/** Blurs (or pixelates) whatever has already been composited inside one effect's box, in
 *  place. Reads back out through a scratch buffer rather than filtering the main canvas
 *  directly — a canvas can't filter itself — copying the box plus a bleed margin so the
 *  blur has real neighbouring pixels to pull in instead of fading out into transparent
 *  black at its own edges. */
function drawBlurEffect(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, effect: TimelineEffect, r: Rect): void {
  const shorter = Math.min(canvas.width, canvas.height);
  const strength = Math.max(0, Math.min(100, effect.blurPct)) / 100;
  const radius = Math.max(1, strength * MAX_EFFECT_BLUR_FRACTION * shorter);

  // Clipped to the canvas — a box dragged half off-frame would otherwise ask drawImage for
  // source pixels that don't exist.
  const bleed = Math.ceil(radius * 3);
  const sx = Math.max(0, Math.floor(r.x - bleed));
  const sy = Math.max(0, Math.floor(r.y - bleed));
  const sw = Math.min(canvas.width, Math.ceil(r.x + r.w + bleed)) - sx;
  const sh = Math.min(canvas.height, Math.ceil(r.y + r.h + bleed)) - sy;
  if (sw <= 0 || sh <= 0) return;

  const scratch = getEffectScratch(sw, sh);
  if (effect.pixelate) {
    // Downscale to one pixel per block, then blow it back up with smoothing off — the
    // standard mosaic. Both dimensions floored at 1px so a tiny box still renders.
    const block = Math.max(2, strength * MAX_EFFECT_PIXEL_FRACTION * shorter);
    const smallW = Math.max(1, Math.round(sw / block));
    const smallH = Math.max(1, Math.round(sh / block));
    const small = getEffectPixelScratch(smallW, smallH);
    small.ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, smallW, smallH);
    scratch.ctx.imageSmoothingEnabled = false;
    scratch.ctx.drawImage(small.canvas, 0, 0, smallW, smallH, 0, 0, sw, sh);
  } else {
    scratch.ctx.filter = "blur(" + radius + "px)";
    scratch.ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    scratch.ctx.filter = "none";
  }

  ctx.save();
  ctx.beginPath();
  traceEffectPath(ctx, effect, r);
  ctx.clip();
  ctx.drawImage(scratch.canvas, 0, 0, sw, sh, sx, sy, sw, sh);
  ctx.restore();
}

// Callout-only animation/border extras (Blur never sees any of this — it stays the plain
// traceEffectPath/drawBlurEffect path above). All three are independent and combine freely:
// a tilted, popping-in, glow-marquee callout is a perfectly valid combination.

/** A "Popout" callout's envelope — 0 the instant it becomes active, ramping up to 1 over
 *  EFFECT_POPUP_MS, held at 1 through the rest of the box's window, then ramping back down
 *  to 0 over the same span right before it goes inactive: pop *in*, then pop back *out*,
 *  not just a one-way entrance. Same trapezoid shape computeZoomEnvelope uses for a zoom
 *  block's own ease in/hold/ease out (including the same half-duration clamp, so a box
 *  shorter than 2×EFFECT_POPUP_MS still gets a full, symmetric in/out instead of the two
 *  transitions overlapping and cutting each other off). 1 outright when popupAnim is off,
 *  so every caller can multiply by this unconditionally instead of branching. */
function effectPopupEnvelope(effect: TimelineEffect, currentMs: number): number {
  if (!effect.popupAnim) return 1;
  const half = Math.max(1, effect.durationMs / 2);
  const transition = Math.min(EFFECT_POPUP_MS, half);
  const tIn = Math.min(1, (currentMs - effect.startMs) / transition);
  const tOut = Math.min(1, (effect.startMs + effect.durationMs - currentMs) / transition);
  return Math.max(0, Math.min(tIn, tOut));
}


/** The callout's outline warped by its own 3D tilt, as a closed polygon in canvas space —
 *  null when the tilt is flat (xDeg = yDeg = 0), which is the caller's cue to fall back to
 *  the cheap, exact traceEffectPath instead (every existing callout, and every Blur box,
 *  takes that path). Reuses project3D (the Zoom track's own tilt math — see its own doc
 *  comment) treating the box itself as the "plane": a rect projects its 4 corners, an oval
 *  is sampled round its rim and each sample projected the same way. Corner rounding is
 *  dropped while tilted — blending true perspective with a rounded rect needs the same
 *  per-cell image-warp drawTiltedPlane uses for zoomed *content*, overkill for a vector
 *  outline. */
function tiltedEffectOutline(effect: TimelineEffect, r: Rect): { x: number; y: number }[] | null {
  if (effect.tilt.xDeg === 0 && effect.tilt.yDeg === 0) return null;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const project = (nx: number, ny: number) => {
    const p = project3D(nx, ny, r.w, r.h, effect.tilt.xDeg, effect.tilt.yDeg);
    return { x: cx + p.x, y: cy + p.y };
  };
  if (effect.shape === "ellipse") {
    const SAMPLES = 40;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const a = (i / SAMPLES) * Math.PI * 2;
      pts.push(project(Math.cos(a) * 0.5, Math.sin(a) * 0.5));
    }
    return pts;
  }
  return [
    project(-0.5, -0.5),
    project(0.5, -0.5),
    project(0.5, 0.5),
    project(-0.5, 0.5),
  ];
}

/** traceEffectPath's callout-only counterpart — same "trace onto the current path, don't
 *  beginPath" contract (see traceEffectPath), but through tiltedEffectOutline first so the
 *  dim cutout, the border/marquee stroke, and the resize-handle-less selection outline all
 *  warp identically. `r` is expected already popup-scaled (see scaledEffectRect) — tilt is
 *  computed from whatever rect it's handed, with no scale awareness of its own. */
function traceCalloutOutline(ctx: CanvasRenderingContext2D, effect: TimelineEffect, r: Rect): void {
  const poly = tiltedEffectOutline(effect, r);
  if (poly) {
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    return;
  }
  traceEffectPath(ctx, effect, r);
}

// One period of a glow callout's brightness pulse / an orbit callout's full lap around the
// box's perimeter, in ms — different numbers so the two read as distinct motions rather
// than the same timing in two different shapes.
const MARQUEE_GLOW_PERIOD_MS = 1400;
const MARQUEE_ORBIT_PERIOD_MS = 2200;

// Every BACKGROUND_GRADIENTS preset (and the Screen tab's own custom gradient — see
// drawBackdrop) renders at this same fixed angle; the marquee's gradient matches it for the
// same reason drawBackdrop does — lining the canvas render up with the CSS
// linear-gradient() the swatch previews are styled with (see drawBackdrop's own comment on
// why the angle math below isn't just canvas's native 0=east convention).
const MARQUEE_GRADIENT_ANGLE_DEG = 135;

/** The marquee's stroke source — a plain color in "solid" mode, a CanvasGradient across the
 *  box's own bounding rect in "gradient" mode, at the same angle (and by the same CSS-angle
 *  formula) drawBackdrop uses for the Screen tab's own gradients, centered on the box
 *  rather than corner-to-corner so it reads the same regardless of the box's aspect ratio.
 *  Built fresh off `r` every call, so it stays correctly placed through a drag/resize/tilt
 *  with no cache to invalidate. */
function resolveMarqueeStroke(ctx: CanvasRenderingContext2D, effect: TimelineEffect, r: Rect): string | CanvasGradient {
  if (effect.marqueeColorMode !== "gradient") return effect.marqueeColor;
  const rad = (MARQUEE_GRADIENT_ANGLE_DEG * Math.PI) / 180;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = (Math.sin(rad) * r.w) / 2;
  const dy = (-Math.cos(rad) * r.h) / 2;
  const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  grad.addColorStop(0, effect.marqueeGradientFrom);
  grad.addColorStop(1, effect.marqueeGradientTo);
  return grad;
}

// How many extra passes drawMarqueeGlow strokes outward from the core line to build its
// halo — more layers reads softer but costs more per-frame stroke calls.
const MARQUEE_GLOW_LAYERS = 4;

/** "Glow" — a pulsing halo around the outline, plus a crisp core pass on top so the ring
 *  itself never reads as just a blurry haze. Built from several progressively wider,
 *  progressively more transparent strokes of the same path rather than ctx.shadowBlur:
 *  canvas shadows render unreliably (faint or missing entirely, inconsistently across
 *  Chromium versions) when strokeStyle is a CanvasGradient rather than a plain color, which
 *  a gradient marquee — the default combination (see createEffect) — hits every time. This
 *  stroke-layers technique works identically for both. `pulse` (0..1) drives both the
 *  halo's own spread and its opacity, so the animation is visible in the glow's size as
 *  well as its brightness, not just a barely-perceptible alpha flicker.
 *
 *  A canvas stroke is centered on its path by default, so a wider line would otherwise
 *  bleed half inward over the box's own dim/content — clipped here to strictly outside the
 *  box's outline (the same even-odd "everything but the hole" trick drawCalloutEffect's own
 *  dim uses) so every halo layer only ever glows outward, never washing out what's inside.
 *  Since only the outer half of each centered stroke survives that clip, the layers' own
 *  width is doubled to land on the same felt spread the un-clipped version had. */
function drawMarqueeGlow(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  effect: TimelineEffect,
  r: Rect,
  borderPx: number,
  alpha: number,
  pulse: number
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  traceCalloutOutline(ctx, effect, r);
  ctx.clip("evenodd");
  for (let i = MARQUEE_GLOW_LAYERS; i >= 1; i--) {
    const t = i / MARQUEE_GLOW_LAYERS;
    ctx.globalAlpha = alpha * 0.16 * t * (0.5 + pulse * 0.5);
    ctx.lineWidth = borderPx + t * borderPx * (1.5 + pulse * 2.5) * 2;
    ctx.beginPath();
    traceCalloutOutline(ctx, effect, r);
    ctx.stroke();
  }
  ctx.restore();

  ctx.globalAlpha = alpha;
  ctx.lineWidth = borderPx;
  ctx.beginPath();
  traceCalloutOutline(ctx, effect, r);
  ctx.stroke();
}

/** The animated border a callout draws instead of drawCalloutEffect's own plain stroke once
 *  `marquee` is on — "glow" (see drawMarqueeGlow) or "orbit", which chases a bright dashed
 *  segment around the box's own perimeter, marquee-light style, using an animated
 *  lineDashOffset (the standard "marching ants" technique) rather than anything hand-rolled
 *  per frame. Traces through traceCalloutOutline, so it inherits whatever tilt/popup-scale
 *  the caller already resolved into `r`. */
function drawMarqueeBorder(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  effect: TimelineEffect,
  r: Rect,
  currentMs: number,
  alpha: number
): void {
  const shorter = Math.min(canvas.width, canvas.height);
  // Marquee needs a visible ring to animate even when the static Border slider is at 0 —
  // that slider still scales it up from here once raised.
  const borderPx = Math.max((effect.borderPct / 100) * shorter, shorter * 0.006);
  const stroke = resolveMarqueeStroke(ctx, effect, r);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = borderPx;

  if (effect.marqueeStyle === "glow") {
    const pulse = 0.5 + 0.5 * Math.sin((currentMs / MARQUEE_GLOW_PERIOD_MS) * Math.PI * 2);
    drawMarqueeGlow(ctx, canvas, effect, r, borderPx, alpha, pulse);
  } else {
    const perim = 2 * (r.w + r.h);
    const dashLen = Math.max(borderPx * 3, perim * 0.12);
    const gapLen = Math.max(perim - dashLen, borderPx);
    ctx.setLineDash([dashLen, gapLen]);
    ctx.lineDashOffset = -((currentMs / MARQUEE_ORBIT_PERIOD_MS) % 1) * perim;
    ctx.beginPath();
    traceCalloutOutline(ctx, effect, r);
    ctx.stroke();
  }
  ctx.restore();
}

// --- Camera bubble border/marquee — the same "plain stroke, or an animated glow/orbit
// ring" idea as the callout marquee above, just ringing the camera bubble's own shape
// (see drawCameraBubbleAt) instead of a callout box. No dim/label/popup/tilt here — the
// bubble has none of those, so this is a much smaller slice of drawCalloutEffect's job.
//
// Tuned independently from the callout marquee's own constants (MARQUEE_ORBIT_PERIOD_MS,
// MARQUEE_GLOW_LAYERS, etc. above): the camera bubble sits on screen continuously through
// a whole recording rather than a callout's brief on-screen window, so a fast chase and a
// wide halo read as distracting there in a way they don't for a callout.
const CAMERA_MARQUEE_ORBIT_PERIOD_MS = 7000;
const CAMERA_MARQUEE_GLOW_LAYERS = 4;

/** Traces the camera bubble's own outline onto the current path — the exact shape
 *  drawCameraBubbleAt already clips its content to (a circle/oval for "round", a rounded
 *  rect sized by cornerRadiusPct otherwise), so the border ring always sits flush with the
 *  bubble's own edge. Doesn't beginPath itself — same "trace only" contract as
 *  traceEffectPath/traceCalloutOutline. */
function traceCameraOutline(ctx: CanvasRenderingContext2D, cam: CameraEditSettings, r: Rect): void {
  if (cam.shape === "round") {
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    return;
  }
  const size = Math.min(r.w, r.h);
  roundedRectPath(ctx, r.x, r.y, r.w, r.h, (cam.cornerRadiusPct / 100) * (size / 2));
}

/** Camera's own copy of resolveMarqueeStroke — same plain-color-or-gradient-across-the-
 *  bubble's-bounding-rect resolution, just reading CameraEditSettings' marquee fields
 *  instead of a TimelineEffect's. */
function resolveCameraMarqueeStroke(ctx: CanvasRenderingContext2D, cam: CameraEditSettings, r: Rect): string | CanvasGradient {
  if (cam.marqueeColorMode !== "gradient") return cam.marqueeColor;
  const rad = (MARQUEE_GRADIENT_ANGLE_DEG * Math.PI) / 180;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = (Math.sin(rad) * r.w) / 2;
  const dy = (-Math.cos(rad) * r.h) / 2;
  const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  grad.addColorStop(0, cam.marqueeGradientFrom);
  grad.addColorStop(1, cam.marqueeGradientTo);
  return grad;
}

/** Camera's own copy of drawMarqueeGlow — see its doc comment for why this is several
 *  progressively-wider clipped stroke layers rather than ctx.shadowBlur. Tuned much more
 *  subtle than the callout's own halo (lower alpha, tighter spread — see
 *  CAMERA_MARQUEE_GLOW_LAYERS) since it sits on screen continuously rather than for a
 *  callout's brief window. */
function drawCameraMarqueeGlow(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cam: CameraEditSettings,
  r: Rect,
  borderPx: number,
  pulse: number
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  traceCameraOutline(ctx, cam, r);
  ctx.clip("evenodd");
  for (let i = CAMERA_MARQUEE_GLOW_LAYERS; i >= 1; i--) {
    const t = i / CAMERA_MARQUEE_GLOW_LAYERS;
    ctx.globalAlpha = 0.22 * t * (0.5 + pulse * 0.5);
    ctx.lineWidth = borderPx + t * borderPx * (2.2 + pulse * 3.2);
    ctx.beginPath();
    traceCameraOutline(ctx, cam, r);
    ctx.stroke();
  }
  ctx.restore();

  ctx.globalAlpha = 1;
  ctx.lineWidth = borderPx;
  ctx.beginPath();
  traceCameraOutline(ctx, cam, r);
  ctx.stroke();
}

/** Paints the camera bubble's own border — a plain stroke in `borderColor`, or (once
 *  `marquee` is on) an animated glow/orbit ring, exactly like the Effects tab's own
 *  drawMarqueeBorder/drawCalloutEffect border branch, just against the bubble's simple,
 *  untilted rect instead of a callout box that can pop/tilt. Called after the bubble's own
 *  content is drawn, so the ring always sits on top of it. */
function drawCameraBorder(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, cam: CameraEditSettings, r: Rect, currentMs: number): void {
  const shorter = Math.min(canvas.width, canvas.height);
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (cam.marquee) {
    // Marquee needs a visible ring to animate even when Thickness is at 0 — same floor
    // drawMarqueeBorder uses, so a 0-thickness marquee bubble still reads clearly.
    const borderPx = Math.max((cam.borderPct / 100) * shorter, shorter * 0.006);
    ctx.strokeStyle = resolveCameraMarqueeStroke(ctx, cam, r);
    ctx.lineWidth = borderPx;
    if (cam.marqueeStyle === "glow") {
      const pulse = 0.5 + 0.5 * Math.sin((currentMs / MARQUEE_GLOW_PERIOD_MS) * Math.PI * 2);
      drawCameraMarqueeGlow(ctx, canvas, cam, r, borderPx, pulse);
    } else {
      const perim = 2 * (r.w + r.h);
      const dashLen = Math.max(borderPx * 3, perim * 0.12);
      const gapLen = Math.max(perim - dashLen, borderPx);
      ctx.setLineDash([dashLen, gapLen]);
      ctx.lineDashOffset = -((currentMs / CAMERA_MARQUEE_ORBIT_PERIOD_MS) % 1) * perim;
      ctx.beginPath();
      traceCameraOutline(ctx, cam, r);
      ctx.stroke();
    }
  } else {
    const borderPx = (cam.borderPct / 100) * shorter;
    if (borderPx >= 0.5) {
      ctx.strokeStyle = cam.borderColor;
      ctx.lineWidth = borderPx;
      ctx.beginPath();
      traceCameraOutline(ctx, cam, r);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** How far Popout has eased into (or back out of) its zoom, 1-3ish (matches popupZoomPct's
 *  own 100-300 range, just expressed as a multiplier) — eased with the same cosine curve a
 *  Zoom block's own pct rides (easeZoomEnvelope), so a Popout callout moves with the same
 *  feel as the Zoom track's. 1 outright when popupAnim is off, so the caller never needs to
 *  branch on it separately from reading this value. */
function effectPopupZoomScale(effect: TimelineEffect, envelope: number): number {
  if (!effect.popupAnim) return 1;
  return 1 + ((effect.popupZoomPct - 100) / 100) * easeZoomEnvelope(envelope);
}

/** `r` scaled by `scale` around its own center — Popout zooms the *whole* callout (dim
 *  cutout, border/marquee, label) as one unit, not just the content inside a fixed frame,
 *  so this is what every part of drawCalloutEffect below traces against instead of `r`
 *  directly. Applied before tilt, so the two compose naturally (tilt always sees the
 *  already-zoomed size as its plane). Everything *outside* the box is still never touched —
 *  "the rest of the screen" stays completely static regardless of how big this box gets. */
function scaledEffectRect(r: Rect, scale: number): Rect {
  const w = r.w * scale;
  const h = r.h * scale;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** Re-draws whatever's already composited in the box's own *resting* area (`r`) stretched
 *  to fill its current, Popout-scaled one (`dr`) — a self-copy, canvas back onto itself,
 *  which is well-defined for a plain drawImage (unlike ctx.filter, which is why
 *  drawBlurEffect needs a separate scratch buffer). Since `r` and `dr` share the same
 *  center (scaledEffectRect only ever scales around it), stretching the fixed-size `r` into
 *  the bigger `dr` *is* zooming the content in lockstep with the box's own growth — the
 *  shape and what's inside it enlarge together, exactly as if the whole callout (not just
 *  its outline) were one zoomed-in unit. Read *before* this callout's own dim/border/label
 *  go on top, so those never get caught in the zoom themselves; clipped to `dr`'s own
 *  (possibly tilted) outline so nothing spills past the box's current edge. No-op when `dr`
 *  is `r` itself (Popout off, or exactly at rest), both as a cheap early-out and because the
 *  self-copy would otherwise be a no-op anyway. */
function drawCalloutContentZoom(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, effect: TimelineEffect, r: Rect, dr: Rect): void {
  if (dr === r) return;
  ctx.save();
  ctx.beginPath();
  traceCalloutOutline(ctx, effect, dr);
  ctx.clip();
  ctx.drawImage(canvas, r.x, r.y, r.w, r.h, dr.x, dr.y, dr.w, dr.h);
  ctx.restore();
}

/** Paints one callout: the Popout content-zoom (if any — see drawCalloutContentZoom), the
 *  dim over everything the box *doesn't* cover (an even-odd fill of the whole canvas with
 *  the box punched out of it), its border (plain, or an animated marquee — see
 *  drawMarqueeBorder), and its optional label chip. `currentMs` drives the Popout envelope
 *  (see effectPopupEnvelope) that the whole box's own zoom, the content inside it, and the
 *  dim/border/label's fade-in/out all ride; `r` is always the box's true, undistorted rest
 *  position — the zoom is resolved into a local `dr` here rather than mutating it, so
 *  hit-testing/drag handles (which read the caller's own `r`) stay exactly where the user
 *  last left the box regardless of how big it's currently drawn. */
function drawCalloutEffect(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, effect: TimelineEffect, r: Rect, currentMs: number): void {
  const envelope = effectPopupEnvelope(effect, currentMs);
  const alpha = envelope; // already 1 outright when popupAnim is off — see its own doc comment
  const zoomScale = effectPopupZoomScale(effect, envelope);
  const dr = zoomScale === 1 ? r : scaledEffectRect(r, zoomScale);

  drawCalloutContentZoom(ctx, canvas, effect, r, dr);

  if (effect.dimPct > 0) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "rgba(0, 0, 0, " + Math.min(90, effect.dimPct) / 100 + ")";
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    traceCalloutOutline(ctx, effect, dr);
    ctx.fill("evenodd");
    ctx.restore();
  }

  if (effect.marquee) {
    drawMarqueeBorder(ctx, canvas, effect, dr, currentMs, alpha);
  } else {
    const borderPx = (effect.borderPct / 100) * Math.min(canvas.width, canvas.height);
    if (borderPx >= 0.5) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = effect.color;
      ctx.lineWidth = borderPx;
      ctx.lineJoin = "round";
      ctx.beginPath();
      traceCalloutOutline(ctx, effect, dr);
      ctx.stroke();
      ctx.restore();
    }
  }

  const label = effect.label.trim();
  if (label) {
    const fontPx = Math.max(14, Math.min(canvas.width, canvas.height) * 0.028);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = "600 " + fontPx + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = "middle";
    const padX = fontPx * 0.55;
    const chipH = fontPx * 1.7;
    const chipW = ctx.measureText(label).width + padX * 2;
    // Sits just above the box's (untilted) bounding area, flipping to just below it when
    // there's no room above — anchored to `dr` (the zoomed rect), so the label rides along
    // with the box's own current size instead of floating over a resting position.
    const above = dr.y - chipH - fontPx * 0.35;
    const chipY = above >= 0 ? above : Math.min(canvas.height - chipH, dr.y + dr.h + fontPx * 0.35);
    const chipX = Math.max(0, Math.min(canvas.width - chipW, dr.x));
    ctx.fillStyle = effect.color;
    ctx.beginPath();
    roundedRectPath(ctx, chipX, chipY, chipW, chipH, chipH * 0.28);
    ctx.fill();
    // Dark text on the one light swatch, white on the rest — a white callout with white
    // text would otherwise be an empty chip.
    ctx.fillStyle = effect.color.toLowerCase() === "#ffffff" ? "#14161f" : "#ffffff";
    ctx.fillText(label, chipX + padX, chipY + chipH / 2);
    ctx.restore();
  }
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
    mediaItems,
    camera,
    onCameraChange,
    background,
    cursor,
    layout,
    onLayoutChange,
    timeline,
    onTimelineChange,
    activeEffectId = null,
    onActiveEffectChange,
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
  // One hidden playback element per added-media pool item (EditProject.media), keyed by
  // that item's id — a <video> for a video item (the draw loop paints the active piece
  // straight out of it), a plain Audio() for an audio one. Keyed by *item*, not by placed
  // piece: several pieces cut from the same file share one element, which is also why the
  // same file placed twice over the same instant can only ever be at one position — the
  // topmost piece covering the playhead wins (see syncMediaElements).
  const mediaElsRef = useRef<Map<string, HTMLVideoElement | HTMLAudioElement>>(new Map());
  const blurVideoRef = useRef<HTMLVideoElement | null>(null);
  const blurHandleRef = useRef<CameraBlurHandle | null>(null);
  const segmentationRef = useRef<CameraSegmentationHandle | null>(null);
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
    /** All four are set only for a frame that actually *draws* an Ext Video piece (see the
     *  draw loop's overlay block, which fills them in after the fact) and null otherwise —
     *  so a piece hidden behind the recording, or none playing at all, simply isn't
     *  hit-testable, and the screen/camera boxes underneath stay grabbable as usual.
     *  `extVideoClipId` is which piece is on screen, so a drag knows whose settings to
     *  write back to (its own override, or the track master). */
    extVideoRect: Rect | null;
    extVideoDrag: DragRegion | null;
    extVideoResizeHandles: Record<Corner, Rect> | null;
    extVideoClipId: string | null;
    /** Every Effects box actually painted this frame (one that's timed out of this instant
     *  isn't grabbable either), in paint order — hit-tested back-to-front so the topmost
     *  overlapping box is the one a click lands on. */
    effectRects: { id: string; rect: Rect }[];
    /** Corner grab zones for the *selected* box only — an unselected box is moved by
     *  clicking it first, same as any other editor. Null when nothing is selected, or the
     *  selection isn't on screen this instant. */
    effectResizeHandles: Record<Corner, Rect> | null;
    canvasW: number;
    canvasH: number;
  }>({
    screenRect: { x: 0, y: 0, w: 0, h: 0 },
    cameraRect: null,
    screenDrag: null,
    cameraDrag: null,
    screenResizeHandles: cornerHandles({ x: 0, y: 0, w: 0, h: 0 }, 0),
    cameraResizeHandles: null,
    extVideoRect: null,
    extVideoDrag: null,
    extVideoResizeHandles: null,
    extVideoClipId: null,
    effectRects: [],
    effectResizeHandles: null,
    canvasW: 0,
    canvasH: 0,
  });
  // Which Ext Video piece a drag actually grabbed, captured at pointerdown. Not read live
  // off interactionRef during the drag: playback keeps running under the pointer, so the
  // piece on screen can change (or end) mid-drag, and the settings being edited must stay
  // the ones the user grabbed rather than following the playhead onto a different piece.
  const extDragClipIdRef = useRef<string | null>(null);
  const dragStateRef = useRef<
    | {
        mode: "move";
        target: "screen" | "camera" | "extVideo";
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
    | { mode: "resize"; target: "screen" | "camera" | "extVideo"; corner: Corner; anchorX: number; anchorY: number; startClientX: number; startClientY: number }
    // Screen-only, while reelScreenFull: dragging pans which part of the (necessarily
    // cropped, to cover with no letterbox gap) recording is visible, instead of moving
    // the box — a full-bleed box has no on-canvas position worth dragging, and sliding it
    // like a normal box would just expose blank background on the side it moved away
    // from rather than reveal the part of the video that's actually hidden there.
    | { mode: "pan"; grabDX: number; grabDY: number; startClientX: number; startClientY: number }
    // The two Effects-box drags. Unlike the screen/camera/Ext boxes above, an effect box
    // is a plain free rectangle in canvas-% space with no DragRegion behind it — position
    // and size are stored directly (see TimelineEffectBox), so both move and resize write
    // absolute values straight from the pointer.
    // boxW/boxH are captured at grab rather than re-read each move: an effect timed to a
    // stretch of the timeline can scroll out from under a drag that's still in progress,
    // and the box being moved must keep its own size rather than stall.
    | { mode: "effectMove"; id: string; grabDX: number; grabDY: number; boxW: number; boxH: number; startClientX: number; startClientY: number }
    | { mode: "effectResize"; id: string; anchorX: number; anchorY: number; startClientX: number; startClientY: number }
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

  // Memoized backdrop bitmap — see drawBackdropCached.
  const backdropCacheRef = useRef<BackdropCache | null>(null);
  // The Ext Video track's own, kept separate so a frame that draws both backdrops doesn't
  // make the two evict each other's bitmap every single frame.
  const extBackdropCacheRef = useRef<BackdropCache | null>(null);
  // Loaded backdrop images, keyed by URL — covers the master Screen backdrop *and* every
  // per-clip override's own (timeline.clipOverrides), any of which can be the one actually
  // resolved as `bg` at a given frame (see the draw loop's own per-clip override
  // resolution). A single image ref keyed only off the master `background` prop used to
  // mean a clip override that picked a *different* texture/image never actually loaded —
  // the draw loop kept blitting whichever texture the master happened to have last loaded,
  // regardless of what `bg.textureId`/`imageId` actually said for that frame. Entries are
  // `"loading"` while in flight so concurrent frames don't kick off the same fetch twice;
  // there's no eviction — bounded by however many distinct fills master+overrides actually
  // use, never unbounded.
  const backdropImagesRef = useRef<Map<string, HTMLImageElement | "loading">>(new Map());
  function ensureBackdropImageLoaded(url: string): HTMLImageElement | null {
    const cached = backdropImagesRef.current.get(url);
    if (cached === "loading") return null;
    if (cached) return cached;
    backdropImagesRef.current.set(url, "loading");
    const img = new Image();
    // Needed for the media:// (custom-image backdrop) case — see screenVideo's own
    // crossOrigin comment below for why. A no-op for the bundled texture/preset URLs,
    // which are same-origin either way.
    img.crossOrigin = "anonymous";
    img.onload = () => {
      backdropImagesRef.current.set(url, img);
    };
    img.onerror = () => {
      backdropImagesRef.current.delete(url);
    };
    img.src = url;
    return null;
  }

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

  // Mirrored for the draw loop and the export/offline-audio passes, which need to map a
  // piece's `mediaId` back to a file path outside of React's render cycle.
  const mediaItemsRef = useRef(mediaItems);
  useEffect(() => {
    mediaItemsRef.current = mediaItems;
  }, [mediaItems]);

  const timelineRef = useRef(timeline);
  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);

  // Same read-in-the-draw-loop/pointer-handlers-without-re-registering pattern as every
  // other prop above — the draw loop is registered once, on mount.
  const activeEffectIdRef = useRef(activeEffectId);
  useEffect(() => {
    activeEffectIdRef.current = activeEffectId;
  }, [activeEffectId]);
  const onActiveEffectChangeRef = useRef(onActiveEffectChange);
  useEffect(() => {
    onActiveEffectChangeRef.current = onActiveEffectChange;
  }, [onActiveEffectChange]);

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
  //
  // Neither element's own `.muted` needs a dedicated sync effect any more: the draw loop
  // (which runs every live frame regardless of play state) sets both, every frame, from
  // whichever cut is actually active right now — see its own per-frame mute resolution.
  // What *does* need tracking here is which tab's mute governs audioOnly at all: the Camera
  // tab's, when there's a real camera file to carry the mic, or the Screen tab's, for a
  // screen-only recording whose separately-captured audio.wav has no Camera tab to reach it
  // (see EditProjectMedia.audioFilePath's own doc comment). Set once per project load (the
  // Load effect below, which is what actually knows cameraFilePath at that instant) rather
  // than read straight from the `cameraFilePath` prop inside the draw loop — that loop's own
  // effect only runs once at mount (see its `[]` deps), so anything it needs from props has
  // to arrive via a ref like this one, not a closure over the prop itself.
  const micFollowsCameraRef = useRef(!!cameraFilePath);

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
    // audio lives now (see micFollowsCameraRef's own comment), so silencing it here would
    // drop system sound from every recording that also has a mic. Harmless for the projects
    // that don't have any — an unmuted video with no audio track is silent either way. Just
    // an initial value — the draw loop overwrites it every frame from here on.
    screenVideo.muted = backgroundRef.current.muted;
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
      // Just an initial value, same as screenVideo's above — the draw loop overwrites it
      // every frame. cameraFilePath is read directly here (not micFollowsCameraRef, still
      // set from *last* load) since this effect is what's actually establishing it fresh.
      audioOnly.muted = cameraFilePath ? cameraRef.current.muted : backgroundRef.current.muted;
      audioOnlyRef.current = audioOnly;
    }
    micFollowsCameraRef.current = !!cameraFilePath;

    // progress/duration (the preview's own scrub bar, in seconds/fraction) are set from
    // inside the draw loop below instead of "timeupdate" — the loop already resolves
    // edited-timeline position every frame via the clips sequence, and that's what the
    // scrub bar needs to reflect, not screenVideo's own raw source-time progress.
    function onEnded() {
      // The screen *source* has run out of footage. That's the end of playback only if
      // nothing on the timeline reaches past where the screen track itself ends: an Ext
      // Video/Ext Audio piece placed beyond the recording keeps playing through the gap
      // that follows, which the draw loop advances by wall-clock time and stops on its own
      // once it actually reaches the end (see its `editedMsRef.current >= totalMs` check).
      // Stopping unconditionally here is what used to strand the playhead at the
      // recording's end and make everything past it unreachable during playback.
      const extent = resolveTimelineExtent();
      if (extent && extent.totalMs > totalClipsExtentMs(extent.clips)) return;
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

  // Keeps the added-media element pool in step with the project's own media list: an
  // element is created the first time an item shows up and torn down when it's removed, so
  // adding or removing one file never disturbs the others' loaded state. Deliberately keyed
  // off the *pool*, not off the placed pieces — moving, trimming, cutting or deleting a
  // piece must never re-load the file behind it mid-playback.
  useEffect(() => {
    const pool = mediaElsRef.current;
    const wanted = new Set(mediaItems.map((m) => m.id));
    for (const [id, el] of pool) {
      if (wanted.has(id)) continue;
      // Same "clear src, then load()" release the main media elements do — pause alone
      // leaves the media:// request (and the file handle behind it) open. See the load
      // effect's own cleanup comment.
      el.pause();
      el.removeAttribute("src");
      el.load();
      pool.delete(id);
    }
    for (const item of mediaItems) {
      if (pool.has(item.id)) continue;
      const el = item.kind === "video" ? document.createElement("video") : new Audio();
      if (el instanceof HTMLVideoElement) {
        // See screenVideo's own crossOrigin comment — without it, drawing this element
        // onto the canvas taints it and the export's pixel reads fail.
        el.crossOrigin = "anonymous";
        el.playsInline = true;
      }
      el.preload = "auto";
      // Starts unmuted — added media is an entirely separate file from the recording, with
      // no Screen/Camera cut whose mute it could plausibly inherit. The only thing that
      // silences one is the Ext Video tab's own mute, reapplied per frame by
      // syncMediaElements; an Ext Audio element is never touched after this.
      el.muted = false;
      el.src = mediaUrl(item.filePath);
      pool.set(item.id, el);
    }
  }, [mediaItems]);

  // Unmount (not every pool change — that's the effect above) — release every element's
  // file handle, same as the main load effect's own cleanup.
  useEffect(() => {
    const pool = mediaElsRef.current;
    return () => {
      for (const el of pool.values()) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      pool.clear();
    };
  }, []);

  /** Puts every added-media element where the edited playhead says it should be, once per
   *  live frame: whichever piece covers `currentMs` on its track decides that element's
   *  source position and whether it's playing at all; an element no piece currently covers
   *  is paused. An Ext Video piece is the one thing here that *can* be silenced — see
   *  ExtVideoEditSettings.muted; an Ext Audio piece has no mute of its own (it is the
   *  sound), so its element is left playing. The same drift tolerance as the audio-only track's
   *  own sync (a re-seek only once it's more than a frame or two out) — seeking every frame
   *  would stutter the audio. Live preview only: during export nothing plays in real time,
   *  and the export loop positions the one video element it needs itself (see exportVideo). */
  function syncMediaElements(currentMs: number, timelineState: TimelineEditSettings) {
    const pool = mediaElsRef.current;
    if (pool.size === 0) return;
    // mediaId → source ms it should be sitting at right now. The Video track contributes
    // only its topmost covering piece (that's the one actually drawn — see the draw loop);
    // every covering Audio piece contributes, since overlapping audio simply mixes.
    const targets = new Map<string, number>();
    // Elements the Ext Video track wants silenced this instant (its piece's own mute, or
    // the track master's). Kept as a set rather than folded into `targets` because a muted
    // piece still *plays* — it's drawn, it just makes no sound.
    const mutedIds = new Set<string>();
    const activeVideo = resolveClipAt(timelineState.videoClips, currentMs);
    if (activeVideo) {
      targets.set(activeVideo.clip.mediaId, activeVideo.sourceMs);
      if (extVideoSettingsFor(timelineState, activeVideo.clip.id).muted) mutedIds.add(activeVideo.clip.mediaId);
    }
    for (const c of timelineState.audioClips) {
      const dur = Math.max(0, c.sourceEnd - c.sourceStart);
      if (currentMs >= c.timelineStart && currentMs < c.timelineStart + dur) {
        targets.set(c.mediaId, c.sourceStart + (currentMs - c.timelineStart));
      }
    }
    const playing = isPlayingRef.current;
    for (const [mediaId, el] of pool) {
      const targetMs = targets.get(mediaId);
      if (targetMs === undefined) {
        if (!el.paused) el.pause();
        continue;
      }
      // Always assigned, not just when muting: unmuting a piece (or moving the playhead
      // off a muted one onto an unmuted piece of the same file) has to put it back.
      el.muted = mutedIds.has(mediaId);
      const targetSec = targetMs / 1000;
      if (Math.abs(el.currentTime - targetSec) > 0.15) el.currentTime = targetSec;
      if (!playing && !el.paused) el.pause();
      else if (playing && el.paused) el.play().catch(() => {});
    }
  }

  // Background blur — rebuild the blurred camera output whenever the level changes.
  // Skipped while removeBackground is on: it takes over from blur entirely (see the
  // segmentation effect below), and a capture-stream video can't carry alpha anyway, so
  // there'd be nothing useful to build here.
  useEffect(() => {
    blurHandleRef.current?.stop();
    blurHandleRef.current = null;
    blurVideoRef.current = null;
    const cameraVideo = cameraVideoRef.current;
    if (!cameraVideo || camera.removeBackground || camera.blur === "none") return;
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
  }, [camera.blur, camera.removeBackground, cameraFilePath]);

  // Background removal — runs live segmentation directly against the raw camera video
  // (see startCameraSegmentation) whenever it's on; draw() reads its latest mask each
  // frame via segmentationRef and composites it onto the camera bubble itself.
  useEffect(() => {
    segmentationRef.current?.stop();
    segmentationRef.current = null;
    const cameraVideo = cameraVideoRef.current;
    if (!cameraVideo || !camera.removeBackground) return;
    segmentationRef.current = startCameraSegmentation(cameraVideo);
    return () => {
      segmentationRef.current?.stop();
      segmentationRef.current = null;
    };
  }, [camera.removeBackground, cameraFilePath]);

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
      const timelineState = timelineRef.current;
      // Per-clip Screen/Camera overrides (timeline.clipOverrides/cameraClipOverrides),
      // resolved against whichever clip was active as of the *previous* frame's resolution
      // (activeClipIdRef/activeCameraClipIdRef aren't updated for *this* frame until the
      // Clips/Camera resolution blocks below run) — during live playback this is off by at
      // most one frame exactly at the instant a cut boundary is crossed, imperceptible and
      // self-correcting the very next frame (same drift tolerance already accepted
      // elsewhere in this file); during export, the export loop already sets both refs to
      // this exact frame's resolved clip before calling draw(), so there's no lag there at
      // all. Falls back to the tab's own master settings wherever the active clip (if any)
      // has no override of its own.
      const cam = (activeCameraClipIdRef.current && timelineState.cameraClipOverrides[activeCameraClipIdRef.current]) || cameraRef.current;
      const bg = (activeClipIdRef.current && timelineState.clipOverrides[activeClipIdRef.current]) || backgroundRef.current;
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

      const backdropUrl = backdropImageUrlFor(bg);
      const backdropImg = backdropUrl ? ensureBackdropImageLoaded(backdropUrl) : null;
      drawBackdropCached(ctx, bg, backdropImg, canvas.width, canvas.height, backdropCacheRef);

      // Clips — each has its own independent timelineStart and can freely overlap another
      // (the last one in the array wins wherever they overlap); a stretch nothing covers
      // is a gap, which plays as real, silent background rather than being skipped —
      // tracked by wall-clock time since there's no video position to read there. A clip
      // actually playing is tracked the usual way, off screenVideo's own currentTime,
      // handing off to whatever (if anything) covers the moment right after it ends.
      // `currentMs` below — and therefore zoom/Camera-clip lookups — is edited time, not
      // raw source time, so those travel with the edited output, not with moved footage.
      // (`timelineState` itself is declared up above `cam`/`bg`, which resolve their own
      // per-clip overrides from it before those clips are even known here.)
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
      // How far the recording itself reaches, as against `totalMs` below, which the added-
      // media tracks can push past it. The config-only tracks (Cursor/Layout/Sound) resolve
      // against this: they describe how the *recording* is composited, so past the end of the
      // footage there's nothing for them to apply to and they fall back to their tab's master
      // settings (see resolveSegmentSettings). Tiling them to the full extent instead would
      // stretch the last cut's override out behind an Ext piece dropped after the end — which
      // is also exactly what the Timeline draws, so the two have to agree.
      const footageTotalMs = Math.max(totalClipsExtentMs(clips), totalClipsExtentMs(cameraClips));
      let currentMs = 0;
      // The added-media tracks extend the edited timeline exactly like the Camera track
      // does — a music bed or an outro clip placed past the end of the footage grows the
      // output to fit rather than being silently cut off at the recording's own end.
      let totalMs = Math.max(
        totalClipsExtentMs(cameraClips),
        totalClipsExtentMs(timelineState.videoClips),
        totalClipsExtentMs(timelineState.audioClips)
      );
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
        onTimeUpdateRef.current?.(currentMs, totalMs, sourceDurationMs, alignedLengthMs);
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
        // screenVideo carries system audio (or, for an already-muxed single file with no
        // separate mic, the entire soundtrack) — muted per the Screen tab's own per-cut
        // override, re-applied every live frame so it tracks the playhead's own cut instead
        // of only the tab's master toggle. `bg` is already resolved against
        // activeClipIdRef above, same object every other Screen visual property this frame
        // reads from — its own `muted` is just one more field on it.
        screenVideo.muted = bg.muted;
        const audioOnly = audioOnlyRef.current;
        if (audioOnly) {
          // audioOnly carries the mic — the camera file's own track when there's a real
          // camera to give it a Camera tab, else a screen-only recording's separately-
          // captured audio.wav, which has no Camera tab to reach and so follows the Screen
          // tab's mute instead (see micFollowsCameraRef's own comment). `cam` is resolved
          // the same way `bg` is, just against the Camera track's own active clip.
          audioOnly.muted = micFollowsCameraRef.current ? cam.muted : bg.muted;
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

        // Added media (the Video/Audio tracks) follows the same edited clock but plays its
        // own sound unconditionally — see syncMediaElements' own comment on why it never
        // touches `.muted`. Live only: export renders all audio offline, and positions the
        // Video track's element itself (see exportVideo/renderExportAudio).
        syncMediaElements(currentMs, timelineState);
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

      // Cursor/Layout per-cut overrides (timeline.cursorSegments/layoutSegments) —
      // `currentMs`/`totalMs` are fully resolved by this point (unlike `cam`/`bg` above,
      // which have to make do with last frame's active-clip id), so these need no lag at
      // all: the exact segment covering this exact frame, every frame. `layoutOverride`
      // only ever supplies the free-position/size fields actually read for box geometry
      // further down — canvas dimensions (layoutSettings.format, sized above) stay
      // master-only, and so do the on-canvas drag/resize interaction handlers (elsewhere in
      // this file), which intentionally keep editing `layoutRef.current` directly.
      // Cursor tiles the Clips track's own extent, not footageTotalMs — the synthetic
      // cursor is only ever drawn over screen content (see the showScreenContent guard on
      // its own draw below) and its cuts stay linked to Clips pieces, so the Camera track
      // has no say in how far it reaches. Same split the Timeline draws its two strips
      // with (see its cursorDurationMs). Only matters for the fabricated whole-track
      // default; a real segment carries its own bounds either way.
      const cursorSettings = resolveSegmentSettings(
        timelineState.cursorSegments, cursorRef.current, currentMs, totalClipsExtentMs(clips)
      );
      const layoutOverride = resolveSegmentSettings(timelineState.layoutSegments, layoutSettings, currentMs, footageTotalMs);

      // Zoom — a timeline zoom block temporarily overrides the Background tab's static
      // zoomPct with an eased-in/out target for the duration of its window.
      const activeZoom = findActiveZoom(timelineState.zooms, currentMs);
      const zoomEnvelope = computeZoomEnvelope(activeZoom, currentMs);
      const zoomedBg: BackgroundEditSettings = { ...bg, zoomPct: computeActiveZoomPct(bg.zoomPct, activeZoom, zoomEnvelope) };
      const activeZoomTilt = computeActiveZoomTilt(activeZoom, zoomEnvelope);

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
      const cameraOrigin = resolveDragPos(layoutOverride.freeCameraPos, cameraDrag, { x: 100, y: 100 });

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
      const boxW = (layoutOverride.freeScreenSizePct / 100) * canvas.width;
      const boxH = (layoutOverride.freeScreenHeightPct / 100) * canvas.height;
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
      const screenOrigin = resolveDragPos(layoutOverride.reelScreenFull ? null : layoutOverride.freeScreenPos, screenDrag, {
        x: 50,
        y: 50,
      });
      let screenBox: Rect = { x: screenOrigin.x, y: screenOrigin.y, w: boxW, h: boxH };

      if (layoutSettings.format === "landscape" && layoutSettings.landscapeMode === "split" && layoutOverride.freeScreenPos === null && cameraRect) {
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
        // Filled in by the overlay block further down, once it knows whether an Ext Video
        // piece is actually on screen this frame — null here so a frame that draws none
        // leaves nothing stale behind for the pointer handlers to hit-test against.
        extVideoRect: null,
        extVideoDrag: null,
        extVideoResizeHandles: null,
        extVideoClipId: null,
        // Filled in by the Effects block further down, once it knows which boxes this
        // instant actually paints — same "nothing stale left behind" reasoning as the four
        // Ext Video entries above.
        effectRects: [],
        effectResizeHandles: null,
        canvasW: canvas.width,
        canvasH: canvas.height,
      };

      const screenFitMode = layoutSettings.format === "reel" && layoutOverride.reelScreenFull ? "cover" : "contain";
      const screenPanPct = layoutOverride.reelScreenFull
        ? { x: layoutOverride.freeScreenPos?.xPct ?? 50, y: layoutOverride.freeScreenPos?.yPct ?? 50 }
        : { x: 50, y: 50 };
      const fit = drawScreenContent(
        ctx,
        screenVideo,
        zoomedBg,
        screenBox,
        screenFitMode,
        screenPanPct,
        showScreenContent,
        zoomFocusSrc,
        activeZoomTilt
      );
      const { screenDrawX, screenDrawY, fitScale, srcX, srcY, svW, svH, warpPoint } = fit;

      // Synthetic cursor overlay — screenVideo never has the cursor baked in (see
      // getEditProjectMedia), so it's drawn live here from the recorded track (reusing the
      // sample taken above for the zoom-focus crop, rather than searching it again).
      // Skipped entirely during a deleted (blank) Clips stretch, same as the screen/camera
      // content — and skipped altogether when cursorBakedIn, since screenVideo *does* have
      // a real one baked in there and drawing this on top of it would show two cursors.
      if (showScreenContent && track && cursorSample && !cursorBakedInRef.current && !cursorSettings.hidden) {
        const { point, pos } = cursorSample;
        const frame = frameDimensions(track.metadata);
        const icon = track.icons[point.icon];
        if (pos && icon) {
          const cur = cursorSettings;
          let scaleX = (svW / frame.width) * fitScale;
          let scaleY = (svH / frame.height) * fitScale;
          const sizeMul = cur.sizePct / 100;
          let px = screenDrawX + (pos.x * (svW / frame.width) - srcX) * fitScale;
          let py = screenDrawY + (pos.y * (svH / frame.height) - srcY) * fitScale;
          // An active 3D zoom's tilt has already warped the content itself (see fit.warpPoint,
          // set by drawScreenContent) — reposition/rescale the cursor overlay to match, so it
          // rides the tilted plane instead of floating over it at its old flat position.
          if (warpPoint) {
            const warped = warpPoint(px, py);
            px = warped.x;
            py = warped.y;
            scaleX *= warped.scale;
            scaleY *= warped.scale;
          }
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
              const color = cursorSettings.color;
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

      // An added-media Video piece plays *instead of* the composited frame underneath, so
      // it goes over the screen content (but under the camera bubble, drawn after it below,
      // and under the editing-only chrome further down, which never reaches the export
      // anyway). Only the topmost covering piece is drawn — same last-in-the-array-wins
      // stacking the Clips track uses. It fills the *gaps* in the recording, though:
      // wherever a Clips piece also covers this instant, the recording wins and the Ext
      // piece stays hidden (its own sound still plays — see syncMediaElements/
      // renderExportAudio, neither of which consults this), so an Ext piece parked over
      // live footage doesn't black it out. Works identically during export: the loop there
      // has already put editedMsRef, and this element's own position, exactly where this
      // frame needs them.
      const overlayResolved = showScreenContent ? null : resolveClipAt(timelineState.videoClips, currentMs);
      const overlayEl = overlayResolved ? mediaElsRef.current.get(overlayResolved.clip.mediaId) : undefined;
      // Declared out here (not inside the block) so the editing chrome below can outline
      // the same box and draw its handles.
      let extVideoRect: Rect | null = null;
      let extVideoResizeHandles: Record<Corner, Rect> | null = null;
      if (overlayResolved && overlayEl instanceof HTMLVideoElement && overlayEl.videoWidth > 0) {
        // Composited through the same helpers the screen recording is (see
        // ExtVideoEditSettings), so backdrop/padding/rounded corner/zoom/crop all behave
        // identically on both tabs. Its own backdrop, when it has one, covers the whole
        // canvas rather than just its box — this piece is playing *instead of* the frame
        // underneath, so leaving that showing around the edges would read as a bug. A
        // "none" fill deliberately paints nothing at all and lets it show through.
        const ext = extVideoSettingsFor(timelineState, overlayResolved.clip.id);
        if (ext.fill !== "none") {
          const extUrl = backdropImageUrlFor(ext);
          const extImg = extUrl ? ensureBackdropImageLoaded(extUrl) : null;
          drawBackdropCached(ctx, ext, extImg, canvas.width, canvas.height, extBackdropCacheRef);
        }
        extVideoRect = extVideoBox(ext, canvas.width, canvas.height);
        extVideoResizeHandles = cornerHandles(extVideoRect, handleSize);
        drawScreenContent(ctx, overlayEl, ext, extVideoRect);
        // Drag/resize this piece exactly like the screen box or camera bubble — see
        // interactionRef's own comment on these four.
        interactionRef.current.extVideoRect = extVideoRect;
        interactionRef.current.extVideoDrag = extVideoDragRegion(ext, canvas.width, canvas.height);
        interactionRef.current.extVideoResizeHandles = extVideoResizeHandles;
        interactionRef.current.extVideoClipId = overlayResolved.clip.id;
      }

      // The camera bubble goes on top of everything composited so far — screen content and
      // any Ext Video piece alike. It's the one layer that's *the presenter* rather than
      // the material being presented: a b-roll insert playing full-frame should still have
      // them talking over the top of it, not swallow them. (Hit-testing in hitTest is
      // ordered to match, camera before Ext Video.)
      const source = cameraSource;
      if (cameraRect && source) {
        const mask = cam.removeBackground ? (segmentationRef.current?.getMask() ?? null) : null;
        drawCameraBubbleAt(ctx, source, cam, cameraRect.x, cameraRect.y, cameraRect.w, cameraRect.h, mask);
        if (cam.marquee || cam.borderPct > 0) drawCameraBorder(ctx, canvas, cam, cameraRect, currentMs);
      }

      // Effects tab — the callout/blur boxes, painted over the finished composite (screen
      // content, any Ext Video piece, and the camera bubble alike): a callout ringing the
      // presenter is exactly as valid as one ringing a menu, and a blur has to be able to
      // cover whatever ends up on top of the thing being hidden. Real output rather than
      // editing chrome, so — unlike the outlines below — this runs during export too.
      // Painted in array order, so a later box lands on top of an earlier one.
      const effectHits: { id: string; rect: Rect }[] = [];
      for (const effect of timelineState.effects ?? []) {
        if (!isEffectActiveAt(effect, currentMs)) continue;
        const r = effectRect(effect, canvas.width, canvas.height);
        effectHits.push({ id: effect.id, rect: r });
        if (effect.kind === "blur") drawBlurEffect(ctx, canvas, effect, r);
        else drawCalloutEffect(ctx, canvas, effect, r, currentMs);
      }
      interactionRef.current.effectRects = effectHits;
      const activeEffectHit = effectHits.find((e) => e.id === activeEffectIdRef.current) ?? null;
      const effectResizeHandles = activeEffectHit ? cornerHandles(activeEffectHit.rect, handleSize) : null;
      interactionRef.current.effectResizeHandles = effectResizeHandles;

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
        if (extVideoRect) ctx.strokeRect(extVideoRect.x + 1, extVideoRect.y + 1, extVideoRect.w - 2, extVideoRect.h - 2);
        // Every effect box gets an outline — a box that paints almost nothing (a gentle
        // blur, a callout with no dim and no border) would otherwise be impossible to find
        // and grab. The selected one is picked out in the accent color, and is the only one
        // with corner handles (see effectResizeHandles).
        for (const hit of effectHits) {
          ctx.strokeStyle = hit.id === activeEffectIdRef.current ? "rgba(129, 116, 255, .95)" : "rgba(255, 255, 255, .35)";
          ctx.strokeRect(hit.rect.x + 1, hit.rect.y + 1, hit.rect.w - 2, hit.rect.h - 2);
        }
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(255, 255, 255, .9)";
        ctx.strokeStyle = "rgba(0, 0, 0, .55)";
        ctx.lineWidth = 1;
        for (const handles of [screenResizeHandles, cameraResizeHandles, extVideoResizeHandles, effectResizeHandles]) {
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
  /** Both footage tracks' effective clip lists plus the edited timeline's own overall
   *  extent — the one computation the draw loop, seekToEditedMs and the screen video's
   *  `ended` handler all have to agree on. `totalMs` counts the added-media tracks too: an
   *  Ext Video/Ext Audio piece placed past the end of the recording genuinely extends the
   *  output, and anything that clamps a position to "the end of the timeline" while
   *  disagreeing about where that is makes the stretch past the footage unreachable — which
   *  is exactly what a seek clamped to footage-only used to do. Null when there's no loaded
   *  screen video to measure against yet. */
  function resolveTimelineExtent(): {
    clips: TimelineClip[];
    cameraClips: TimelineClip[];
    sourceDurationMs: number;
    totalMs: number;
  } | null {
    const screenVideo = screenVideoRef.current;
    if (!screenVideo || !screenVideo.duration) return null;
    // See the draw loop's identical computation for the reasoning behind all of this.
    const sourceDurationMs = screenVideo.duration * 1000;
    const cameraSourceDurationMs = cameraDurationMsRef.current ?? sourceDurationMs;
    const offsetMs = sideClipOffsetMsRef.current;
    const alignedLengthMs = Math.min(Math.max(0, sourceDurationMs - offsetMs), cameraSourceDurationMs);
    const t = timelineRef.current;
    const clips = effectiveClips(t.clips, sourceDurationMs, 0, alignedLengthMs, offsetMs);
    const cameraClips = effectiveClips(t.cameraClips, cameraSourceDurationMs, 0, alignedLengthMs);
    const totalMs = Math.max(
      totalClipsExtentMs(clips),
      totalClipsExtentMs(cameraClips),
      totalClipsExtentMs(t.videoClips),
      totalClipsExtentMs(t.audioClips)
    );
    return { clips, cameraClips, sourceDurationMs, totalMs };
  }

  function seekToEditedMs(editedMs: number) {
    const screenVideo = screenVideoRef.current;
    const cameraVideo = cameraVideoRef.current;
    if (!screenVideo || !screenVideo.duration) return;
    const extent = resolveTimelineExtent();
    if (!extent) return;
    const { clips, cameraClips, totalMs } = extent;
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
    // Click-effect bookkeeping — any explicit jump (scrubbing the ruler, clicking a
    // Timeline piece, the chip rail's own "seek to this cut") has to reset both of these,
    // or they carry stale state into whatever plays next:
    //  - rippleRef holds an in-flight ripple's `startedAt` in *edited* ms. A seek
    //    backward past that point makes `currentMs - startedAt` go negative, which never
    //    satisfies the ripple's own "> RIPPLE_DURATION_MS, clear it" check — so on the
    //    very next forward playback, the stale ripple sits there rendering with negative
    //    progress until currentMs climbs all the way back past where it originally
    //    fired, reading as a click effect stuck "playing in slow motion" for however far
    //    back the seek jumped.
    //  - lastPlaybackMsRef is the click-sweep watermark, in raw *source* ms (cursorTMs) —
    //    left stale after a seek, a later forward-playing frame can either skip every
    //    click between the old watermark and the new position (watermark now ahead of
    //    playback) or fire all of them at once the instant playback finally catches back
    //    up to it (watermark left behind). Reset to wherever this seek actually landed so
    //    the very next frame's sweep starts clean from here — a seek should never
    //    retroactively trigger (or lose) a click, only playback moving through it should.
    rippleRef.current = null;
    lastPlaybackMsRef.current = screenVideo.currentTime * 1000;
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

  /** Every edited-ms position where any track's clip resolution could possibly change
   *  (each clip's own start and end) — the boundaries between export's seek segments. A
   *  track only needs re-seeking exactly at the points where what's "current" for it
   *  actually changes; everywhere in between every track just keeps playing forward from
   *  wherever the previous segment left it. Takes each participating track's clip list
   *  (screen, camera, and the added-media Video/Audio tracks). */
  function exportSegmentBreaks(totalMs: number, ...lists: TimelineClip[][]): number[] {
    const points = new Set<number>([0, totalMs]);
    for (const list of lists) {
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

  /** [startSec, muted] breakpoints across the edited timeline for one footage track's own
   *  audio-mute intent -- resolved exactly like the live draw loop resolves its per-frame
   *  bg/cam (see the draw loop's own per-clip-override comment): whichever piece covers a
   *  given instant supplies its own override if it has one, else the tab's master `muted`;
   *  a gap (nothing covers that instant) also falls back to master. Breakpoints sit at
   *  every piece's own start/end, since those are the only points the resolved answer can
   *  possibly change at. Shared by the Screen and Camera tracks below -- each just calls
   *  this with its own clip list, override map and master flag. */
  function buildMuteWindows(
    clipsForTrack: TimelineClip[],
    overrides: Record<string, { muted: boolean }>,
    masterMuted: boolean
  ): { startSec: number; muted: boolean }[] {
    const points = new Set<number>([0]);
    for (const c of clipsForTrack) {
      points.add(Math.max(0, c.timelineStart));
      points.add(Math.max(0, c.timelineStart + Math.max(0, c.sourceEnd - c.sourceStart)));
    }
    return Array.from(points)
      .sort((a, b) => a - b)
      .map((ms) => {
        const resolved = resolveClipAt(clipsForTrack, ms);
        const muted = resolved ? (overrides[resolved.clip.id]?.muted ?? masterMuted) : masterMuted;
        return { startSec: ms / 1000, muted };
      });
  }

  // Renders export's entire audio track in one deterministic, non-realtime pass via
  // OfflineAudioContext -- completely decoupled from the frame-stepped video capture (see
  // exportVideo), and the only way to get synthesized click sounds into the export at
  // all: playClickSound's envelopes are pinned to a live AudioContext's real-time clock,
  // which has no meaning during non-realtime rendering. Mirrors the live draw loop's own
  // audio rules -- see screenVideo.muted/audioOnly.muted's own comments in the draw loop
  // for the full split; clicks are always keyed to the screen recording's own source clock
  // (the cursor track is always tied to screenFilePath, camera or not) and skipped
  // entirely when the screen recording has a real cursor baked into its pixels, exactly
  // like the live click detection this mirrors (see cursorBakedInRef's own doc comment).
  // Returns null when there's nothing to render (everything muted, no added media, no
  // click sound, no clicks) rather than encoding a silent WAV nobody needs. `decodeAudio`
  // (the caller's ffmpeg-backed decoder -- see exportVideo's own opts) is what actually
  // turns each source file into something decodeAudioData can reliably read in full;
  // decoding the raw source directly here doesn't work; see decodeAudio's own doc comment
  // for why.
  async function renderExportAudio(
    totalMs: number,
    // How far the recording itself reaches -- where each footage track's own pieces stop, as
    // against totalMs, which the added-media tracks can push past it. See the draw loop's
    // footageTotalMs for why the two differ.
    footageTotalMs: number,
    // Only for click timing below (see its use at sourceToEditedMs). Taken from the caller
    // rather than recomputed here so it's guaranteed the exact same default/edited clips
    // actually driving the video export, not a second, potentially drifting computation.
    clips: TimelineClip[],
    cameraClips: TimelineClip[],
    decodeAudio: (filePath: string) => Promise<ArrayBuffer>
  ): Promise<ArrayBuffer | null> {
    const cur = cursorRef.current;
    const track = cursorTrackRef.current;
    const clicks = !cursorBakedInRef.current && cur.clickSound ? (track?.metadata.clicks ?? []) : [];

    // Two independent mute timelines -- one per recorded audio source, exactly mirroring the
    // live draw loop's screenVideo/audioOnly split (see its own comments): the screen
    // track's own cuts and their per-clip override govern system audio; the mic follows
    // either the Camera track's cuts (a real camera file) or, absent one, the same Screen
    // track windows (a screen-only recording's separately-captured audio.wav has no Camera
    // tab to reach it). micMuteWindows === screenMuteWindows (literally the same array) in
    // that second case, so the closing breakpoint below only needs writing once either way.
    const screenMuteWindows = buildMuteWindows(clips, timelineRef.current.clipOverrides, backgroundRef.current.muted);
    const micFollowsCamera = !!cameraFilePath;
    const micMuteWindows = micFollowsCamera
      ? buildMuteWindows(cameraClips, timelineRef.current.cameraClipOverrides, cameraRef.current.muted)
      : screenMuteWindows;
    // Past the last footage piece there's no cut to speak for the stretch -- an Ext Video/Ext
    // Audio piece placed after the recording -- so each track's own master mute governs it,
    // same fallback resolveSegmentSettings/buildMuteWindows itself already applies to a gap.
    // Load-bearing: each source's gain node only gets a breakpoint per window, so without
    // one here it would simply hold whatever the last footage piece set.
    if (footageTotalMs < totalMs) {
      screenMuteWindows.push({ startSec: footageTotalMs / 1000, muted: backgroundRef.current.muted });
      if (micFollowsCamera) micMuteWindows.push({ startSec: footageTotalMs / 1000, muted: cameraRef.current.muted });
    }
    const sideAudioPath = cameraFilePath ?? audioFilePath;
    const recordedSourcesAllMuted =
      screenMuteWindows.every((w) => w.muted) && (!sideAudioPath || micMuteWindows.every((w) => w.muted));
    // Added media (EditProject.media): every placed Audio piece, plus every placed Video
    // piece that isn't muted -- an inserted clip brings its own sound with it, which is why
    // both tracks feed in here. It plays regardless of either *recorded* source's own mute
    // (a separate file, with no Screen/Camera cut to inherit from); the one thing that
    // silences a piece is the Ext Video tab's own mute -- its own override or the track
    // master's -- which the live draw loop's syncMediaElements applies the same way. A
    // project with only Ext pieces and both recorded channels muted still needs a real
    // render, which is what hasPlacedMedia below is for.
    const placedMedia: TimelineMediaClip[] = [
      ...timelineRef.current.audioClips,
      ...timelineRef.current.videoClips.filter((c) => !extVideoSettingsFor(timelineRef.current, c.id).muted),
    ];
    const hasPlacedMedia = placedMedia.length > 0;

    if (recordedSourcesAllMuted && clicks.length === 0 && !hasPlacedMedia) return null;

    const SAMPLE_RATE = 44100;
    const numSamples = Math.max(1, Math.ceil((totalMs / 1000) * SAMPLE_RATE));
    const offlineCtx = new OfflineAudioContext(2, numSamples, SAMPLE_RATE);

    if (!recordedSourcesAllMuted) {
      // Two independent recorded sources, mixed here into one export track -- the same two
      // the live preview plays through two separate elements (see the draw loop's own
      // screenVideo/audioOnly comments):
      //
      //  - the screen track, which is where system audio ("system sound") lives on every
      //    platform now, and which for an already-muxed single-file source is the entire
      //    soundtrack on its own. Always at offset 0: it *is* the reference timeline.
      //  - the side clip's mic -- the camera track's own audio, or a screen-only
      //    recording's separately-captured audio.wav -- which starts sideClipOffsetMs into
      //    that timeline (see sideClipOffsetMsRef's doc comment) because its recorder
      //    starts after screen capture is already rolling.
      //
      // Either can be missing or silent, and both are decoded independently so one failing
      // never costs the other: a project recorded with system sound off has a silent screen
      // track, one recorded with no mic has no side clip at all, and anything recorded
      // before system audio moved to the screen track has both mixed together in the side
      // clip against a silent screen track -- which still comes out right here, since that
      // mixed clip is simply one of the two sources and the other contributes nothing.
      const sources: { path: string; startSec: number; muteWindows: { startSec: number; muted: boolean }[] }[] = [
        { path: screenFilePath, startSec: 0, muteWindows: screenMuteWindows },
        ...(sideAudioPath
          ? [{ path: sideAudioPath, startSec: Math.max(0, sideClipOffsetMsRef.current / 1000), muteWindows: micMuteWindows }]
          : []),
      ];

      for (const { path: sourceAudioPath, startSec, muteWindows } of sources) {
        try {
          const wavBytes = await decodeAudio(sourceAudioPath);
          const decoded = await offlineCtx.decodeAudioData(wavBytes);
        // One continuous, unedited buffer source spanning the whole export (from its own
        // start offset on) -- not gated by either track's own clips. Neither the Camera
        // track's pieces (see cameraClips's own independent-editing comment) nor the screen
        // Clips track's own cuts/gaps are something the user is actually editing *audio* by
        // touching: a gap on either track just means blank visual background for that
        // stretch (see the draw loop's own "plays as real, silent background" comment) --
        // real elapsed time nothing stops the underlying recording's own audio from
        // continuing straight through, on both counts. edited-ms and raw source-ms are the
        // same clock for audio's purposes specifically because of that: it's the one track
        // never subject to remapping, past the fixed start-offset shift. Only *muting* it
        // is genuinely per-cut -- see buildMuteWindows above.
          const durSec = Math.min(decoded.duration, Math.max(0, totalMs / 1000 - startSec));
          if (durSec > 0) {
            const src = offlineCtx.createBufferSource();
            src.buffer = decoded;
            // Routed through a gain node (rather than straight to destination) so the mute
            // breakpoints above can silence specific cut spans -- hard on/off steps, same as
            // a <video>'s own .muted flag toggling live, no fades.
            const gain = offlineCtx.createGain();
            for (const w of muteWindows) gain.gain.setValueAtTime(w.muted ? 0 : 1, Math.max(0, w.startSec));
            src.connect(gain);
            gain.connect(offlineCtx.destination);
            src.start(startSec, 0, durSec);
          }
        } catch {
          // No audio track on this source, or it failed to decode -- skip just this one.
          // The other source (and the click sounds below) still render.
        }
      }
    }

    // The added-media pieces resolved above. Rendered unconditionally (outside the
    // recordedSourcesAllMuted guard) and connected straight to destination with no gain
    // node: an Ext piece's mute is all-or-nothing for the whole piece, so a muted one is
    // simply absent from `placedMedia` rather than needing breakpoints the way the two
    // recorded sources' per-cut mutes do. Unlike those sources these *are* clip-gated,
    // because here the pieces are the edit: each is scheduled at its own timelineStart,
    // offset into its file by its own sourceStart, so a trimmed or cut piece contributes
    // exactly the stretch it shows on the timeline. Decoded buffers are cached by path, so
    // several pieces cut from one file decode it once.
    const decodedByPath = new Map<string, AudioBuffer>();
    for (const clip of placedMedia) {
      const item = mediaItemsRef.current.find((m) => m.id === clip.mediaId);
      if (!item) continue; // its file was removed from the project's media pool
      const startSec = clip.timelineStart / 1000;
      if (startSec >= totalMs / 1000) continue;
      try {
        let decoded = decodedByPath.get(item.filePath);
        if (!decoded) {
          decoded = await offlineCtx.decodeAudioData(await decodeAudio(item.filePath));
          decodedByPath.set(item.filePath, decoded);
        }
        const offsetSec = clip.sourceStart / 1000;
        const durSec = Math.min(
          (clip.sourceEnd - clip.sourceStart) / 1000,
          Math.max(0, totalMs / 1000 - startSec),
          Math.max(0, decoded.duration - offsetSec)
        );
        if (durSec <= 0) continue;
        const src = offlineCtx.createBufferSource();
        src.buffer = decoded;
        src.connect(offlineCtx.destination);
        src.start(startSec, offsetSec, durSec);
      } catch {
        // Moved/unreadable file, or one with no audio track at all (a silent video
        // insert) -- skip just this piece; everything else still renders.
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
      // Added media extends the output the same way the Camera track does — see the live
      // draw loop's identical totalMs computation.
      const videoClips = timelineRef.current.videoClips;
      const audioClips = timelineRef.current.audioClips;
      const totalMs = Math.max(
        totalClipsExtentMs(clips),
        totalClipsExtentMs(cameraClips),
        totalClipsExtentMs(videoClips),
        totalClipsExtentMs(audioClips)
      );
      if (totalMs <= 0) throw new Error("There's nothing on the timeline to export.");

      const audioWavBytes = await renderExportAudio(
        totalMs,
        Math.max(totalClipsExtentMs(clips), totalClipsExtentMs(cameraClips)),
        clips,
        cameraClips,
        opts.decodeAudio
      );
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
      // Fresh click-effect bookkeeping for this export run — these two refs otherwise
      // still hold whatever live preview last left them at (wherever the user last
      // scrubbed/played before hitting Export), which the frame loop below has no reason
      // to agree with (see seekToEditedMs's identical reset for the full reasoning: a
      // stale rippleRef can render "stuck," and a stale lastPlaybackMsRef can skip or
      // pile up click ripples on whichever frame first crosses it).
      rippleRef.current = null;
      lastPlaybackMsRef.current = -1;
      // Both videos get played forward (sped up) during capture — audio is already fully
      // rendered separately by this point (see above) and never needed from these
      // elements directly, so mute them for the duration regardless of the live Mute
      // toggle, or an unmuted export would blast sped-up audio out the speakers.
      const origScreenMuted = screenVideo.muted;
      const origCameraMuted = cameraVideo?.muted;
      screenVideo.muted = true;
      if (cameraVideo) cameraVideo.muted = true;
      // Same for every added-media element, for the same reason — their audio is already in
      // the offline render above. Also stops any of them that live preview left playing:
      // only the one Video-track element this loop actually needs is driven from here.
      const mediaEls = Array.from(mediaElsRef.current.values());
      const origMediaMuted = mediaEls.map((el) => el.muted);
      for (const el of mediaEls) {
        el.pause();
        el.muted = true;
      }
      try {
        const frameDurationMs = 1000 / opts.fps;
        const totalFrames = Math.max(1, Math.round((totalMs / 1000) * opts.fps));
        const breakpoints = exportSegmentBreaks(totalMs, clips, cameraClips, videoClips, audioClips);

        let screenClipId: string | null = null;
        let cameraClipId: string | null = null;
        let screenClip: TimelineClip | null = null;
        let cameraClip: TimelineClip | null = null;
        // The Video track's currently-covering piece, driven exactly like the two above —
        // only one plays (and is drawn) at a time, the topmost covering piece, so one
        // element's worth of seeking is all this needs. The Audio track has no
        // frame-by-frame work at all here: its sound came out of renderExportAudio.
        let overlayClipId: string | null = null;
        let overlayClip: TimelineMediaClip | null = null;
        let overlayEl: HTMLVideoElement | null = null;
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
          // Null wherever the recording itself covers this segment — the Clips track wins
          // that overlap and draw() skips the Ext piece there, so there's nothing to seek
          // or wait on either (segment breaks include every Clips boundary, so screen
          // coverage can't change part-way through one).
          const overlayResolved = screenResolved ? null : resolveClipAt(videoClips, segStart);
          if ((overlayResolved?.clip.id ?? null) !== overlayClipId) {
            overlayEl?.pause();
            overlayClipId = overlayResolved?.clip.id ?? null;
            overlayClip = overlayResolved?.clip ?? null;
            const el = overlayResolved ? mediaElsRef.current.get(overlayResolved.clip.mediaId) : undefined;
            overlayEl = el instanceof HTMLVideoElement ? el : null;
            if (overlayResolved && overlayEl) {
              await seekAndWait(overlayEl, overlayResolved.sourceMs / 1000);
              if (cancelled) break;
              overlayEl.playbackRate = MAX_EXPORT_PLAYBACK_RATE;
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
          if (overlayClip && overlayEl) {
            waits.push(
              waitUntilSourceTime(overlayEl, (overlayClip.sourceStart + (targetMs - overlayClip.timelineStart)) / 1000, reachableEndSec)
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
          overlayEl?.pause();
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
        overlayEl?.pause();

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
        mediaEls.forEach((el, i) => {
          el.pause();
          el.playbackRate = 1;
          el.muted = origMediaMuted[i];
        });
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

  type DragTarget = "camera" | "screen" | "extVideo";
  type Hit =
    | { kind: DragTarget; action: "resize"; corner: Corner }
    | { kind: DragTarget; action: "move" }
    // Effects boxes carry which box was hit — unlike the three singleton targets above
    // there can be any number of them on the frame at once.
    | { kind: "effect"; id: string; action: "resize"; corner: Corner }
    | { kind: "effect"; id: string; action: "move" };

  // Resize handles take priority over the body-drag hit test — they're small, so a
  // near-corner grab should always resize rather than move.
  function hitTest(pt: { x: number; y: number }, info: (typeof interactionRef)["current"]): Hit | null {
    // Topmost first, matching the draw order: Effects boxes (painted over everything),
    // then the camera bubble, then any Ext Video piece, then the screen box. The Ext
    // entries are null on any frame that draws no Ext piece, which hands the canvas
    // straight back to the screen box below.
    const activeEffect = activeEffectIdRef.current;
    if (activeEffect && info.effectResizeHandles) {
      for (const corner of CORNERS) {
        if (pointInRect(pt.x, pt.y, info.effectResizeHandles[corner])) return { kind: "effect", id: activeEffect, action: "resize", corner };
      }
    }
    // Back-to-front, so the box painted on top is the one a click in an overlap lands on.
    for (let i = info.effectRects.length - 1; i >= 0; i--) {
      const box = info.effectRects[i];
      if (pointInRect(pt.x, pt.y, box.rect)) return { kind: "effect", id: box.id, action: "move" };
    }
    if (info.cameraResizeHandles) {
      for (const corner of CORNERS) {
        if (pointInRect(pt.x, pt.y, info.cameraResizeHandles[corner])) return { kind: "camera", action: "resize", corner };
      }
    }
    if (info.cameraRect && info.cameraDrag && pointInRect(pt.x, pt.y, info.cameraRect)) return { kind: "camera", action: "move" };
    if (info.extVideoResizeHandles) {
      for (const corner of CORNERS) {
        if (pointInRect(pt.x, pt.y, info.extVideoResizeHandles[corner])) return { kind: "extVideo", action: "resize", corner };
      }
    }
    if (info.extVideoRect && info.extVideoDrag && pointInRect(pt.x, pt.y, info.extVideoRect)) return { kind: "extVideo", action: "move" };
    for (const corner of CORNERS) {
      if (pointInRect(pt.x, pt.y, info.screenResizeHandles[corner])) return { kind: "screen", action: "resize", corner };
    }
    if (info.screenDrag && pointInRect(pt.x, pt.y, info.screenRect)) return { kind: "screen", action: "move" };
    return null;
  }

  /** Writes back what a preview drag just changed about the Ext Video piece on screen.
   *  Into that piece's *own* override when it has one, else into the track master — i.e.
   *  whichever object was actually in force for what the user grabbed (the same resolution
   *  the draw loop itself uses, see extVideoSettingsFor), so dragging always changes exactly
   *  the thing that moved rather than silently editing a master the piece was overriding.
   *  Every field it writes is absolute (derived from the pointer's position, never from the
   *  previous value), so timelineRef lagging a render behind mid-drag can't compound. */
  function commitExtVideoDrag(patch: Partial<ExtVideoEditSettings>) {
    const clipId = extDragClipIdRef.current;
    const t = timelineRef.current;
    const overrides = t.videoClipOverrides ?? {};
    const own = clipId ? overrides[clipId] : undefined;
    if (clipId && own) {
      onTimelineChangeRef.current({ ...t, videoClipOverrides: { ...overrides, [clipId]: { ...own, ...patch } } });
    } else {
      onTimelineChangeRef.current({ ...t, extVideo: { ...(t.extVideo ?? DEFAULT_EXT_VIDEO_EDIT_SETTINGS), ...patch } });
    }
  }

  /** Writes an Effects box's new geometry straight back into `timeline.effects` — same
   *  path any panel edit takes, so a preview drag lands in the undo history and the save
   *  debounce identically. Every value written is absolute (derived from the pointer's own
   *  position, never from the previous one), so timelineRef lagging a render behind
   *  mid-drag can't compound into drift. */
  function commitEffectBox(id: string, box: TimelineEffectBox) {
    const t = timelineRef.current;
    onTimelineChangeRef.current({ ...t, effects: updateEffect(t.effects ?? [], id, { box }) });
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

    if (hit.kind === "effect") {
      // Clicking any box selects it — the Effects panel's chip rail follows, and the corner
      // handles move onto it for whatever drag comes next.
      if (hit.id !== activeEffectIdRef.current) onActiveEffectChangeRef.current?.(hit.id);
      const box = info.effectRects.find((r) => r.id === hit.id)?.rect;
      if (!box) return;
      if (hit.action === "resize") {
        // Same anchor convention as every other box here — the corner opposite the one
        // grabbed is what stays put.
        const anchorX = hit.corner === "tl" || hit.corner === "bl" ? box.x + box.w : box.x;
        const anchorY = hit.corner === "tl" || hit.corner === "tr" ? box.y + box.h : box.y;
        dragStateRef.current = { mode: "effectResize", id: hit.id, anchorX, anchorY, startClientX: e.clientX, startClientY: e.clientY };
      } else {
        dragStateRef.current = {
          mode: "effectMove",
          id: hit.id,
          grabDX: pt.x - box.x,
          grabDY: pt.y - box.y,
          boxW: box.w,
          boxH: box.h,
          startClientX: e.clientX,
          startClientY: e.clientY,
        };
      }
      extDragClipIdRef.current = null;
      didDragRef.current = false;
      guideRef.current = { v: [], h: [] };
      canvas.style.cursor = hit.action === "resize" ? resizeCursor(hit.corner) : "grabbing";
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    const { kind } = hit;
    const boxFor = (k: DragTarget) => (k === "camera" ? info.cameraRect : k === "extVideo" ? info.extVideoRect : info.screenRect);
    if (hit.action === "resize") {
      const box = boxFor(kind);
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
      const box = boxFor(kind);
      const region = kind === "camera" ? info.cameraDrag : kind === "extVideo" ? info.extVideoDrag : info.screenDrag;
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
    extDragClipIdRef.current = kind === "extVideo" ? info.extVideoClipId : null;
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

    if (drag.mode === "effectMove") {
      // Free rectangle in canvas-% space — position is stored outright (see
      // TimelineEffectBox), so there's no DragRegion/travel conversion to do. clampEffectBox
      // (inside updateEffect) is what keeps a grabbable sliver of it on frame.
      const canvasW = interactionRef.current.canvasW || canvas.width;
      const canvasH = interactionRef.current.canvasH || canvas.height;
      commitEffectBox(drag.id, {
        xPct: ((pt.x - drag.grabDX) / canvasW) * 100,
        yPct: ((pt.y - drag.grabDY) / canvasH) * 100,
        wPct: (drag.boxW / canvasW) * 100,
        hPct: (drag.boxH / canvasH) * 100,
      });
      return;
    }

    if (drag.mode === "effectResize") {
      const canvasW = interactionRef.current.canvasW || canvas.width;
      const canvasH = interactionRef.current.canvasH || canvas.height;
      // The anchor corner and the pointer are simply the box's two opposite corners —
      // boxFromCorners normalizes them whichever way the drag went.
      commitEffectBox(
        drag.id,
        boxFromCorners(
          { xPct: (drag.anchorX / canvasW) * 100, yPct: (drag.anchorY / canvasH) * 100 },
          { xPct: (pt.x / canvasW) * 100, yPct: (pt.y / canvasH) * 100 }
        )
      );
      return;
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

      if (drag.target === "extVideo") {
        // The same free rectangle the screen box is (below), just writing to the Ext Video
        // settings in force for the piece on screen instead of to the layout.
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
        commitExtVideoDrag({
          sizePct,
          heightPct,
          pos: { xPct: offsetToPct(boxX, canvasW - actualW), yPct: offsetToPct(boxY, canvasH - actualH) },
        });
      } else if (drag.target === "screen") {
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

    if (drag.target === "extVideo") {
      commitExtVideoDrag({ pos: { xPct, yPct } });
      return;
    }
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
    extDragClipIdRef.current = null;
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
        {/* No single Mute button here any more — audio is muted per-channel now (Screen's
            own system audio, Camera's own mic), each with its own master + per-cut control
            on its own tab (see BackgroundEditPanel/CameraEditPanel's Audio section), so
            there's no longer one flag this button could toggle. */}
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
