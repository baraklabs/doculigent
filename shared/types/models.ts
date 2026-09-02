
export interface CaptureTarget {
  id: string;
  title: string;
  kind: "display" | "window";
  thumbnailDataUrl?: string;
}

export interface CursorTrackPoint {
  t: number;
  x: number;
  y: number;
  icon: number;
}

export interface CursorIconAsset {
  file: string;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
}

export interface CaptureRegion {
  targetId: string;
  kind: "display" | "window" | "area";
  bounds: { x: number; y: number; width: number; height: number } | null;
  scaleFactor: number;
}

export interface CursorMetadata {
  appVersion: string;
  recordingId: string;
  createdAt: string; // ISO 8601
  capture: CaptureRegion;
  sampleRateHz: number;
  icons: CursorIconAsset[];
  points: CursorTrackPoint[];
  /** Left-click timestamps, ms since recording start — Windows-only (like icon capture),
   *  absent on older recordings and other platforms. Drives the edit preview's optional
   *  click ripple/sound. */
  clicks?: number[];
}

export interface CameraTrackPoint {
  t: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CameraTrackMetadata {
  appVersion: string;
  recordingId: string;
  createdAt: string;
  sampleRateHz: number;
  points: CameraTrackPoint[];
}

export type CameraBlurLevel = "none" | "soft" | "aggressive";

export interface OverlayConfig {
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  sizePct: number;
  circular: boolean;
  showCamera: boolean;
  cameraDeviceId: string | null;
  mirrorCamera: boolean;
  cameraBlur: CameraBlurLevel;
}

export type CameraBubbleShape = "round" | "square" | "rectangle" | "rectangle-vertical";

export interface CameraBubbleConfig {
  shape: CameraBubbleShape;
  roundedCorners: boolean;
  freeformResize: boolean;
  mirror: boolean;
  cameraDeviceId: string | null;
  blur: CameraBlurLevel;
}

export interface CameraBubbleBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RecordingDockOrientation = "horizontal" | "vertical";

export interface RecordingDockConfig {
  orientation: RecordingDockOrientation;
}

export interface RecordingDockBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RecordingDockAction = "pause" | "resume" | "restart" | "stop" | "discard";

export interface RecordingDockTimerSync {
  elapsedMs: number;
  paused: boolean;
}

export interface MicConfig {
  deviceId: string | null;
  muted: boolean;
}

export interface SystemAudioConfig {
  enabled: boolean;
  sourceId: string | null;
}

export type CaptureMode = "display" | "window" | "area" | "camera";

export interface AreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AreaSelectResult {
  targetId: string;
  rect: AreaRect;
}

export interface AutoTranscribeSettings {
  all: boolean;
  recording: boolean;
  videoImport: boolean;
  audioImport: boolean;
  teamsContent: boolean;
}

export type EditProjectSourceKind = "video" | "file" | "recording";

export interface EditProjectSource {
  kind: EditProjectSourceKind;
  /** Library/meeting video id — set when kind === "video". */
  videoId?: string;
  /** Absolute path to the picked file — set when kind === "file". */
  filePath?: string;
  /** Absolute path to a raw recording's own directory (metadata/screen.mp4,
   *  metadata/camera.webm, metadata/cursor.json, etc.) — set when kind === "recording".
   *  Unlike "video"/"file", there's no single anchor file to derive this from (an
   *  in-progress Advanced recording never gets a composited top-level video), so the
   *  directory is stored directly instead. */
  recDir?: string;
}

export type CameraEditShape = "square" | "round" | "rectangle" | "rectangle-vertical";

export interface CameraEditSettings {
  hidden: boolean;
  sizePct: number; // camera bubble size, as a % of the shorter canvas dimension
  shape: CameraEditShape;
  cornerRadiusPct: number; // corner radius as a % of bubble size — ignored by "round" (no corners)
  /** Zooms into the center of the camera feed before it's fit into the bubble — a crop-in
   *  effect, same idea as the Background tab's screen zoom. */
  zoomPct: number; // 100-300
  blur: CameraBlurLevel;
  /** Crops the camera feed from each edge before zoom/fit is applied, each as a % of the
   *  source feed's own width (left/right) or height (top/bottom), 0-45 — same idea as the
   *  Background tab's screen crop. Composes with `removeBackground`: the mask is cropped
   *  the same way, so the segmented cutout still lines up with the cropped frame. */
  cropTopPct: number;
  cropRightPct: number;
  cropBottomPct: number;
  cropLeftPct: number;
  /** Segments the person out of the feed live (see startCameraSegmentation) and draws
   *  only them — the background is cut away entirely rather than blurred, letting
   *  whatever's already behind the bubble (screen recording, backdrop) show through.
   *  Takes over from `blur` while on, which becomes moot (nothing left to blur behind). */
  removeBackground: boolean;
}

export type CursorStyle = "default" | "arrow" | "circle" | "hand" | "crosshair" | "mouse-pointer" | "mouse-simple";

export type ClickAnimationStyle = "ripple" | "pulse" | "burst";
export type ClickSoundStyle = "tick" | "pop" | "click";

export interface CursorEditSettings {
  style: CursorStyle;
  sizePct: number; // scale relative to the recorded cursor's original size, 50-1000
  /** Tint applied to the synthetic styles — ignored by "default", which draws the
   *  actual captured cursor image and can't be reliably recolored (the OS bitmap
   *  doesn't carry trustworthy per-pixel alpha to tint against). */
  color: string;
  /** Solid, fully opaque color fill vs. a thin outline in the same color — ignored by
   *  "default" for the same reason as `color` above. */
  filled: boolean;
  clickEffect: boolean; // click animation on detected left-clicks
  clickAnimationStyle: ClickAnimationStyle;
  clickSound: boolean; // short synthesized sound on detected left-clicks
  clickSoundStyle: ClickSoundStyle;
}

export type BackgroundFill = "none" | "color" | "gradient" | "texture" | "image";

export interface BackgroundEditSettings {
  fill: BackgroundFill;
  colorId: string; // key into BACKGROUND_COLORS — ignored when customColor is set
  gradientId: string; // key into BACKGROUND_GRADIENTS — ignored when customGradient is set
  textureId: string; // key into BACKGROUND_TEXTURES
  imageId: string; // key into BACKGROUND_IMAGES — ignored when customImagePath is set
  /** User-picked solid color, when they chose one from the color wheel instead of a
   *  curated swatch — takes precedence over colorId while set. */
  customColor: string | null;
  /** User-picked two-stop gradient, when they chose their own colors instead of a
   *  curated preset — takes precedence over gradientId while set. Rendered at the same
   *  fixed angle as every preset (135deg). */
  customGradient: { from: string; to: string } | null;
  /** Absolute path to a user-imported image, when they picked one from their computer
   *  instead of a curated preset — takes precedence over imageId while set. */
  customImagePath: string | null;
  paddingPct: number; // screen content inset, as a % of the shorter canvas dimension, 0-20
  cornerRadiusPct: number; // rounded corner radius on the screen content, 0-20
  blurPct: number; // blur applied to the backdrop showing through the padding, 0-100
  zoomPct: number; // zooms into the center of the screen recording, 100-300
  /** Crops the screen recording from each edge before zoom/fit is applied, each as a % of
   *  the source video's own width (left/right) or height (top/bottom), 0-45 — independent
   *  per side, so e.g. cropping a browser chrome strip off the top doesn't need to also
   *  crop the bottom. */
  cropTopPct: number;
  cropRightPct: number;
  cropBottomPct: number;
  cropLeftPct: number;
}

export interface SoundEditSettings {
  muted: boolean;
}

/** The canvas shape: "reel" is a fixed 9:16 portrait canvas; "landscape" is a fixed 16:9
 *  wide canvas. Whichever one, the screen and camera are always freely drag-positioned
 *  and drag-resized directly in the preview. */
export type LayoutFormat = "landscape" | "reel";

/** "landscape"-only — purely which "Camera position" quick layouts to show (see
 *  LayoutEditPanel): "overlay"'s corners dock the camera as a small bubble over a near-
 *  full-bleed screen; "split"'s edge midpoints instead sit them side by side. Both are
 *  one-click starting points, not a locked mode — after clicking one, screen and camera
 *  are equally free to drag/resize independently (and can end up overlapping) either way;
 *  this has no effect on how PreviewCompositor renders anything. */
export type LandscapeMode = "overlay" | "split";

/** A drag-positioned box's top-left anchor, as a % of the region it's free to travel
 *  within — 0-100 keeps it fully on-canvas, but it's allowed to go negative or past 100
 *  too, letting the box be dragged partially (or fully) off-canvas, cut off by the frame
 *  edge like a layer pushed out of frame in any editor. Null until the user actually
 *  drags it, so it starts at a sensible default instead of literal (0, 0). */
export interface FreePosition {
  xPct: number;
  yPct: number;
}

export interface LayoutEditSettings {
  format: LayoutFormat;
  /** "landscape" format only — ignored by "reel". */
  landscapeMode: LandscapeMode;
  /** The screen box's width and height, each as a % of the canvas's own width/height —
   *  fully independent of each other and of the recording's own aspect ratio, exactly
   *  like the camera bubble's free corner-resize. The video itself still fits inside
   *  according to `reelScreenFull` below; an aspect mismatch between the box and the
   *  recording shows as letterbox gap (not) or crop (is), never stretching. */
  freeScreenSizePct: number;
  freeScreenHeightPct: number;
  /** Dragged positions, as a % of the full canvas. */
  freeScreenPos: FreePosition | null;
  freeCameraPos: FreePosition | null;
  /** Crops the screen recording to fill its box completely ("cover") instead of
   *  letterboxing to fit within it ("contain", the default) — set by reel's "(full)"
   *  quick layouts, whose whole point is covering a portrait canvas edge to edge despite
   *  a typically-landscape recording, where "never crop" would mean it visibly can't.
   *  Purely a fit style, independent of the box's own position/size — which stays a
   *  normal freely drag/resizable rectangle either way. */
  reelScreenFull: boolean;
}

export interface EditProject {
  id: string;
  title: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  source?: EditProjectSource;
  camera?: CameraEditSettings;
  cursor?: CursorEditSettings;
  background?: BackgroundEditSettings;
  sound?: SoundEditSettings;
  layout?: LayoutEditSettings;
  timeline?: TimelineEditSettings;
}

/** Unused today — both the Clips and Camera tracks' pieces (and their order) are defined
 *  by `TimelineEditSettings.clips`/`cameraClips` instead. Kept only for save-file
 *  compatibility with cuts saved before that migration. */
export interface TimelineCut {
  id: string;
  startMs: number;
  endMs: number;
  deleted: boolean;
  track?: "clips" | "camera";
}

/** One piece of the Clips (or Camera) track — `sourceStart`/`sourceEnd` are ms into that
 *  track's own source recording (what plays); `timelineStart` is its own independent ms
 *  position on the *edited* timeline (when it plays), completely decoupled from both the
 *  source position and from every other piece — including ones on the other track.
 *  Dragging a piece just changes its `timelineStart` — nothing else moves, there's no
 *  ripple, and two pieces on the same track can freely overlap in timeline time.
 *
 *  Where pieces on the same track overlap, the *last* one in the array wins (array order
 *  doubles as stacking order — grabbing a piece brings it to the end of the array, so
 *  whatever you just moved is always on top). A stretch of the edited timeline covered by
 *  no piece at all is a gap: for `clips`, that plays as a real, silent span of background,
 *  same duration as it visually occupies, rather than being skipped over; for
 *  `cameraClips`, it's simply the camera bubble hidden for that stretch. Deleting a piece
 *  just removes it from the array — since positions are independent, nothing else shifts.
 *
 *  An empty array means "not edited yet" — the whole recording plays as one piece,
 *  `timelineStart: 0`, in its original order. */
export interface TimelineClip {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
}

export const ZOOM_PCT_PRESETS = [150, 200, 250, 300] as const;
export type TimelineZoomPct = (typeof ZOOM_PCT_PRESETS)[number];

/** A movable, repeatable zoom-in effect anchored at a point on the timeline — eases from
 *  the base zoom up to `pct` and back down over ZOOM_TRANSITION_MS at each edge of its
 *  window, holding at `pct` in between. */
export interface TimelineZoom {
  id: string;
  startMs: number;
  durationMs: number;
  pct: TimelineZoomPct;
}

/** Unused today — the Camera track's shown/hidden windows are defined by
 *  `TimelineEditSettings.cameraClips` instead (an empty stretch there — a gap between
 *  pieces — is what plays as hidden now). Kept only for save-file compatibility with
 *  hides saved before that migration. */
export interface TimelineCameraHide {
  id: string;
  startMs: number;
  durationMs: number;
}

export interface TimelineEditSettings {
  /** Unused today — see TimelineCut. */
  cuts: TimelineCut[];
  zooms: TimelineZoom[];
  /** Unused today — see TimelineCameraHide. */
  cameraHides: TimelineCameraHide[];
  /** The Clips track's edited sequence — see TimelineClip. Empty means unedited (whole
   *  recording, original order). */
  clips: TimelineClip[];
  /** The Camera track's edited sequence — same independent-piece model as `clips` (see
   *  TimelineClip), just backed by the camera-only source video instead of the screen
   *  one: each piece drags freely to move, trims at its edges to reveal more of the
   *  camera recording, and pieces can overlap (last one in the array wins). A stretch of
   *  the edited timeline covered by no piece is a real gap — the camera bubble is hidden
   *  there, same as `cam.hidden` but scoped to that stretch. Empty means unedited (camera
   *  shown for the whole recording, in its original order). */
  cameraClips: TimelineClip[];
}

export const DEFAULT_CAMERA_EDIT_SETTINGS: CameraEditSettings = {
  hidden: false,
  sizePct: 25,
  shape: "round",
  cornerRadiusPct: 20,
  zoomPct: 100, // 100 = the slider's own "no zoom" floor (its range is 100-300)
  blur: "none",
  cropTopPct: 0,
  cropRightPct: 0,
  cropBottomPct: 0,
  cropLeftPct: 0,
  removeBackground: false,
};

export const DEFAULT_CURSOR_EDIT_SETTINGS: CursorEditSettings = {
  style: "hand",
  sizePct: 500,
  color: "#f59e0b",
  filled: true,
  clickEffect: true,
  clickAnimationStyle: "burst",
  clickSound: true,
  clickSoundStyle: "tick",
};

/** What "Reset to original" restores on the Cursor tab — the real captured cursor at
 *  its actual size, with none of the edit-time additions (stylized shape, scaling,
 *  click animation/sound) that DEFAULT_CURSOR_EDIT_SETTINGS applies as a starting
 *  preset for new projects. */
export const ORIGINAL_CURSOR_EDIT_SETTINGS: CursorEditSettings = {
  style: "default",
  sizePct: 100,
  color: "#ffffff",
  filled: true,
  clickEffect: false,
  clickAnimationStyle: "ripple",
  clickSound: false,
  clickSoundStyle: "tick",
};

export const DEFAULT_BACKGROUND_EDIT_SETTINGS: BackgroundEditSettings = {
  fill: "texture",
  colorId: "white",
  gradientId: "dusk",
  textureId: "blur-teal",
  imageId: "aurora",
  customColor: null,
  customGradient: null,
  customImagePath: null,
  paddingPct: 5,
  cornerRadiusPct: 10,
  blurPct: 0,
  zoomPct: 100,
  cropTopPct: 0,
  cropRightPct: 0,
  cropBottomPct: 0,
  cropLeftPct: 0,
};

export const DEFAULT_LAYOUT_EDIT_SETTINGS: LayoutEditSettings = {
  format: "landscape",
  landscapeMode: "split",
  // Full-bleed by default (matches "overlay": the camera just floats over it) — only
  // overridden once the user actually drag-resizes the screen box themselves. Landscape's
  // own default is "split" (above) rather than "overlay", but this stays the shared
  // starting point for either — "split" ignores freeScreenPos/Size/Height anyway (its
  // screen box is auto-derived around the camera — see LayoutEditPanel's buildSplitSlots)
  // until the user drags the screen themselves.
  freeScreenSizePct: 100,
  freeScreenHeightPct: 100,
  freeScreenPos: null,
  // "Camera right" — split's own default camera slot (LayoutEditPanel's CAMERA_POSITIONS,
  // "middle-right").
  freeCameraPos: { xPct: 100, yPct: 50 },
  reelScreenFull: false,
};

export const DEFAULT_SOUND_EDIT_SETTINGS: SoundEditSettings = {
  muted: false,
};

export const DEFAULT_TIMELINE_EDIT_SETTINGS: TimelineEditSettings = {
  cuts: [],
  zooms: [],
  cameraHides: [],
  clips: [],
  cameraClips: [],
};

export const ZOOM_DEFAULT_PCT: TimelineZoomPct = 150;
export const ZOOM_DEFAULT_DURATION_MS = 1600;
// How long a new zoom block's ease in/out takes at each edge of its window.
export const ZOOM_TRANSITION_MS = 350;
// A new zoom block starts this many ms before the playhead/selection point that spawned it,
// so the zoom-in anticipates the action instead of reacting to it.
export const ZOOM_LEAD_MS = 300;
// Below this drag distance, a cut-track drag is treated as a stray click, not a real cut.
export const CUT_MIN_DURATION_MS = 200;
export const CAMERA_HIDE_DEFAULT_DURATION_MS = 2000;

export const BACKGROUND_COLORS: { id: string; label: string; color: string }[] = [
  { id: "white", label: "White", color: "#ffffff" },
  { id: "black", label: "Black", color: "#0d0f16" },
  { id: "slate", label: "Slate", color: "#475569" },
  { id: "indigo", label: "Indigo", color: "#4338ca" },
  { id: "violet", label: "Violet", color: "#7c3aed" },
  { id: "rose", label: "Rose", color: "#e11d48" },
  { id: "emerald", label: "Emerald", color: "#059669" },
  { id: "amber", label: "Amber", color: "#d97706" },
];

export interface BackgroundGradientPreset {
  id: string;
  label: string;
  angleDeg: number;
  from: string;
  to: string;
}

export const BACKGROUND_GRADIENTS: BackgroundGradientPreset[] = [
  { id: "dusk", label: "Dusk", angleDeg: 135, from: "#4338ca", to: "#7c3aed" },
  { id: "sunset", label: "Sunset", angleDeg: 135, from: "#f97316", to: "#db2777" },
  { id: "ocean", label: "Ocean", angleDeg: 135, from: "#0284c7", to: "#0f766e" },
  { id: "forest", label: "Forest", angleDeg: 135, from: "#166534", to: "#65a30d" },
  { id: "candy", label: "Candy", angleDeg: 135, from: "#db2777", to: "#f59e0b" },
  { id: "midnight", label: "Midnight", angleDeg: 135, from: "#0f172a", to: "#312e81" },
];

export interface BackgroundTexturePreset {
  id: string;
  label: string;
}

// Curated Unsplash photos (Unsplash License — free to use), bundled locally as assets;
// the actual image URLs live in src/assets/backgrounds/index.ts (renderer-only, since
// this file is also imported from the main process where Vite asset imports don't apply).
export const BACKGROUND_TEXTURES: BackgroundTexturePreset[] = [
  { id: "abstract-noir", label: "Noir Abstract" },
  { id: "bark-blue", label: "Blue Bark" },
  { id: "wall-crimson", label: "Crimson Wall" },
  { id: "bark-closeup", label: "Tree Bark" },
  { id: "fabric-black", label: "Black Fabric" },
  { id: "wavy-crimson", label: "Crimson Waves" },
  { id: "wall-mono", label: "Mono Wall" },
  { id: "abstract-mono", label: "Mono Abstract" },
  { id: "blur-teal", label: "Teal Blur" },
];

export interface BackgroundImagePreset {
  id: string;
  label: string;
}

// Curated Unsplash photos (Unsplash License — free to use), bundled locally as assets;
// the actual image URLs live in src/assets/backgrounds/index.ts (renderer-only, since
// this file is also imported from the main process where Vite asset imports don't apply).
// Users who want something else can still import their own (see customImagePath).
export const BACKGROUND_IMAGES: BackgroundImagePreset[] = [
  { id: "confetti", label: "Confetti" },
  { id: "clouds", label: "Clouds" },
  { id: "galaxy-peak", label: "Starry Peak" },
  { id: "outer-space", label: "Deep Space" },
  { id: "white-leaves", label: "White Leaves" },
  { id: "neon-particles", label: "Neon Particles" },
  { id: "foggy-mountains", label: "Foggy Mountains" },
];

export interface EditProjectMedia {
  /** True only when the source recording kept the screen and camera as separate
   *  files (native full-display capture) — everything else has the camera already
   *  burned into a single video, which can't be repositioned after the fact. */
  editable: boolean;
  /** Absolute path to the screen-only video, when editable. */
  screenFilePath: string | null;
  /** Absolute path to the camera-only video, when editable. */
  cameraFilePath: string | null;
  /** Absolute path to the single composited video otherwise (burned-in, or no
   *  separate camera at all) — null if the source has no playable video. */
  singleFilePath: string | null;
  /** Absolute path to a screen-only recording's own separately-captured mic/system
   *  audio — set only when there's no cameraFilePath to carry it instead (screenFilePath/
   *  singleFilePath's own native capture is always video-only in that case). Null
   *  whenever cameraFilePath is set, or when the underlying source already has audio
   *  muxed directly into its single file. */
  audioFilePath: string | null;
  /** Absolute path to the recorded cursor track's metadata JSON, when present —
   *  screenFilePath never has the cursor burned in, so the editor renders it live. */
  cursorMetadataPath: string | null;
  /** Absolute path to the directory holding that track's cursor icon PNGs. */
  cursorIconsDir: string | null;
  /** True when the video behind screenFilePath/singleFilePath already has a real,
   *  physically-captured OS cursor baked into its pixels — the non-native (no gdigrab)
   *  screen-capture fallback has no way to suppress it at the source. Drawing the
   *  synthetic cursor track on top of one of these would show two cursors, so the editor
   *  skips that render (and any style/replacement it'd otherwise offer) entirely here. */
  cursorBakedIn: boolean;
  /** How many ms into the screen recording's own timeline cameraFilePath/audioFilePath's
   *  own t=0 actually falls — recorded once, at save time (see RecordingService's
   *  screenStartedAtMs/sideClipStartOffsetMs), because that side clip is always started by
   *  a *separate* MediaRecorder, after screen capture is already rolling and after
   *  camera/mic getUserMedia (hundreds of ms to seconds) resolves. Null when there's no
   *  side clip at all (cameraFilePath and audioFilePath both null) or for a project with
   *  no such measurement (predates this field). The editor's default Camera-track clip and
   *  its audio-only playback both start from this offset instead of 0 — without it, the
   *  camera bubble and its audio visibly lead the screen content by exactly this much. */
  sideClipStartOffsetMs: number | null;
  /** The camera bubble config actually used at record time, mapped to edit-settings
   *  shape — used as the Camera tab's starting point (and Reset target) instead of a
   *  generic default, so untouched projects preview exactly as they were recorded. */
  recordedCamera: CameraEditSettings | null;
}

export interface Video {
  id: string;
  title: string;
  filePath: string;
  durationSecs: number;
  overlay: OverlayConfig;
  createdAt: string; // ISO 8601
  transcript: Transcript | null;
  summary: Summary | null;
  source: "record" | "meeting";
  syncedFromTeamFileId?: string;
  /** Camera bubble shape/blur actually in effect while this was recorded — absent for
   *  audio-only recordings and anything saved before this field existed. */
  cameraBubbleConfig?: CameraBubbleConfig;
  /** True when the screen video was captured via the non-native (no gdigrab) fallback,
   *  which bakes the real OS cursor into it — see EditProjectMedia.cursorBakedIn. */
  cursorBakedIn?: boolean;
}

export interface SaveRecordingSideClip {
  bytes: ArrayBuffer;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Actual container of `bytes`, as chosen by RecordingService's pickMimeType — "mp4" when
   *  the renderer's MediaRecorder produced real H.264 (preferred on Windows/Linux whenever
   *  MediaRecorder.isTypeSupported confirms it's available), "webm" for the VP9/Opus
   *  fallback, which is also what macOS always records for video (see pickMimeType's own
   *  comment for why). Lets the main process pick the matching file extension and skip a
   *  redundant transcode when the clip is already H.264. */
  ext: "mp4" | "webm";
}

/** The system-audio ("system sound") clip, recorded by the renderer on the platforms
 *  where Chromium can capture desktop loopback at all (Windows/Linux). Kept apart from the
 *  camera side clip's mic audio deliberately: system audio belongs to the *screen* track,
 *  and gets muxed into it at save time (see ipc/recording.ts's resolveScreenTrack), so all
 *  three platforms end up with one layout — system audio in the screen track, mic in the
 *  camera clip. macOS never sends this: ScreenCaptureKit writes system audio straight into
 *  the capture file instead (see native/screenCapture.ts's isCaptureRecordingSystemAudio),
 *  which is the only route to it there. */
export interface SaveRecordingSystemAudioClip {
  bytes: ArrayBuffer;
  /** Always "webm" today — pickMimeType only ever reaches for H.264/MP4 on a stream that
   *  carries video, and this one is audio-only. */
  ext: "mp4" | "webm";
  /** How many ms after the screen recording's own t=0 this clip's recorder started, same
   *  clock and same purpose as sideClipStartOffsetMs — the mux shifts the audio by this
   *  much so it lines up with the video it was recorded against. */
  startOffsetMs: number | null;
}

export interface SaveRecordingInput {
  webmBytes?: ArrayBuffer;
  /** Container of `webmBytes` — "mp4" when MediaRecorder recorded real H.264/AAC directly
   *  (camera-only Quick Recording), "webm" otherwise. Optional and defaults to "webm" so any
   *  caller that predates this field still behaves exactly as before. */
  webmExt?: "mp4" | "webm";
  screenFilePath?: string;
  screenBytes?: ArrayBuffer;
  /** Container of `screenBytes` (the non-native getDisplayMedia fallback) — same "mp4" when
   *  supported / "webm" otherwise convention as webmExt. */
  screenExt?: "mp4" | "webm";
  areaRect?: AreaRect | null;
  sideClip?: SaveRecordingSideClip;
  /** Windows/Linux only — see SaveRecordingSystemAudioClip. */
  systemAudioClip?: SaveRecordingSystemAudioClip;
  /** How many ms after the screen recording's own t=0 (see RecordingService's
   *  screenStartedAtMs, resolved from screenCapture.start()'s startedAtMs) the sideClip's
   *  own recorder actually started — see EditProjectMedia.sideClipStartOffsetMs, which
   *  this becomes. Undefined when there's no sideClip, or no native/fallback screen clock
   *  to measure it against (e.g. captureMode "camera", which has no sideClip either). */
  sideClipStartOffsetMs?: number | null;
  overlay: OverlayConfig;
  durationSecs: number;
  title: string;
  source: "record" | "meeting";
  /** Quick: composite everything into one video, same as today's default pipeline.
   *  Advanced: keep the raw screen/camera tracks + metadata and open them as an Edit
   *  Project instead of compositing. Absent/undefined behaves as "quick" — preserves
   *  today's behavior for callers (e.g. meetings) that don't know about modes. */
  mode?: "quick" | "advanced";
}

export interface SaveAudioInput {
  audioBytes: ArrayBuffer;
  durationSecs: number;
  title: string;
  transcript: Transcript | null;
}

/** What a completed `recording:save` produced — a Quick recording still yields a single
 *  composited `Video`, but an Advanced recording now yields an Edit Project (raw tracks,
 *  no composite, no library row) instead. */
export type RecordingSaveResult =
  | { kind: "video"; video: Video }
  | { kind: "editProject"; recordingId: string; editProjectId: string; title: string };

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface Transcript {
  language: string;
  engine: "whisper-local" | "whisper.cpp" | "assemblyai" | "deepgram" | "transcript-import";
  segments: TranscriptSegment[];
}

export interface Summary {
  tldr: string;
  keyPoints: string[];
  actionItems: string[];
}

export interface ChatCitation {
  timestamp: number;
  quote: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
  timestamp?: string;
}

export type LlmProviderKind = "ollama" | "lmStudio" | "openAi" | "openRouter" | "anthropic" | "custom";

export const LOCAL_LLM_PROVIDERS: LlmProviderKind[] = ["ollama", "lmStudio"];

export type LlmCapability = "chat" | "transcribe";

export interface LlmProviderConfig {
  kind: LlmProviderKind;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  capabilities: LlmCapability[];
}

export interface LlmModelProfile extends LlmProviderConfig {
  id: string;
  name: string;
}
