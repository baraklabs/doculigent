import { useEffect, useRef, useState } from "react";
import { Minus, MousePointer2, Plus, RotateCcw, Scissors, Trash2 } from "lucide-react";
import { MagicWand } from "@phosphor-icons/react";
import {
  DEFAULT_CURSOR_EDIT_SETTINGS,
  DEFAULT_TIMELINE_EDIT_SETTINGS,
  ZOOM_DEFAULT_DURATION_MS,
  ZOOM_DEFAULT_PCT,
  ZOOM_LEAD_MS,
  ZOOM_TRANSITION_MS,
  type CursorEditSettings,
  type CursorMetadata,
  type EditProjectMediaItem,
  type LayoutEditSettings,
  type TimelineClip,
  type TimelineEditSettings,
  type TimelineMediaClip,
  type TimelineEffect,
  type TimelineEffectKind,
  type TimelineSegment,
  type TimelineZoom,
} from "@shared/types/models";
import {
  bringClipToFront,
  deleteClip,
  effectiveClips,
  resolveClipAt,
  sourceToEditedMs,
  splitClipAtEditedMs,
  splitClipAtSource,
  totalClipsExtentMs,
} from "@shared/lib/timelineClips";
import { effectiveSegments, setSegmentSettings, splitSegmentAtPoint } from "@shared/lib/timelineSegments";
import {
  DEFAULT_NEW_ZOOM_STYLE,
  DEFAULT_NEW_ZOOM_TILT,
  removeZoom as removeZoomLib,
} from "@shared/lib/timelineZooms";
import {
  EFFECT_DEFAULT_DURATION_MS,
  MIN_EFFECT_MS,
  createEffect,
  removeEffect as removeEffectLib,
} from "@shared/lib/timelineEffects";
import { frameDimensions, toFrameCoords } from "@shared/lib/cursorFrame";
import { mediaUrl } from "@shared/constants/media";
import "./Timeline.css";

export type TimelineTool = "default" | "cut";

// Every piece across all seven tracks — Clips/Camera pieces, Zoom blocks, Cursor/Layout
// segments, and the added-media pieces — shares one selection set, keyed as `${track}:${id}`
// (see keyOf below) so a single Set<string> can hold a mixed multi-selection spanning
// tracks. Exported so EditPage's chip rail (focusRequest prop below) and activeTrack can
// reference it.
export type TrackKind = "clips" | "camera" | "zoom" | "callout" | "blur" | "cursor" | "layout" | "video" | "audio";

/** The two Effects rows. Both hold TimelineEffect blocks out of one shared
 *  `timeline.effects` list, split by `kind` — so, exactly like the Video/Audio pair, nearly
 *  all of their handling below is one track-parameterized set rather than two copies of it.
 *  A track kind is literally the effect kind it holds, which is what makes that possible. */
export type EffectTrackKind = TimelineEffectKind;

/** The two tracks backed by the project's *added* media pool (EditProject.media) rather
 *  than by the recording itself — see TimelineMediaClip. Both behave exactly like the
 *  Clips/Camera tracks (free-moving, overlappable, edge-trimmable pieces), so nearly all of
 *  their handling below is one shared, track-parameterized set rather than a third and
 *  fourth copy of it. A track kind doubles as a media *item* kind: a piece on "video" always
 *  plays a video file, one on "audio" always an audio file. */
export type MediaTrackKind = "video" | "audio";

// .tl-inner's own left padding (10px, the .tl-tool-toggle gutter) plus every .tl-row's
// header column (72px) plus the gap Timeline.css puts between it and the track (10px) — where
// the playhead's own left offset below has to start too, so it lines up with the ruler/Clips/
// Zoom/Camera tracks instead of starting under the gutter. The padding has to be included
// explicitly here: it's on .tl-inner, the playhead's positioned ancestor, so it shifts where
// the tracks render (normal flow, pushed in by the padding) but not the playhead's own `left:
// 0` origin (the padding *edge*, which the padding value doesn't move). Unaffected by the
// view zoom below: the header column keeps its fixed width at every zoom level, so only the
// tracks themselves stretch.
const TL_TRACK_START_PX = 92;

/** Drag-and-drop MIME type carrying an added-media item's id from the Edit page's Media
 *  panel onto a Timeline track, suffixed with the track that item belongs on ("video" or
 *  "audio"). Encoding the kind into the *type* rather than the payload is what lets a track
 *  refuse a drag it can't take (an audio file over the Video track) from `dataTransfer.types`
 *  alone — during a dragover the payload itself is unreadable by design, so a check on the
 *  data would come too late to withhold the drop highlight. Exported for the panel that
 *  starts these drags. Lower-case: the DataTransfer API normalizes types to lower case, so
 *  anything else would never match on the way back out. */
export const MEDIA_DRAG_MIME_PREFIX = "application/x-doculigent-media-";

// View-zoom range for the slider under the tool buttons — 1 is fit-to-width (the default,
// and how the timeline has always drawn), 8 spreads the same recording over eight screens.
// The minimum goes one step *below* fit, so the whole timeline can also be pulled in
// slightly narrower than its pane rather than always butting up against both edges.
const VIEW_ZOOM_MIN = 0.9;
const VIEW_ZOOM_MAX = 8;
const VIEW_ZOOM_STEP = 0.1;
// Coarser than the slider's own drag step — a click on -/+ should move the view by an
// obvious amount rather than the barely-visible nudge a 0.1 would give.
const VIEW_ZOOM_BUTTON_STEP = 0.5;

interface TimelineProps {
  timeline: TimelineEditSettings;
  onChange: (next: TimelineEditSettings) => void;
  currentMs: number;
  durationMs: number;
  /** The raw recording's own length — how far a Clips piece's trim handles can reveal
   *  hidden footage back out to, independent of `durationMs` (the edited timeline's own
   *  extent, which can differ once clips are trimmed/moved/overlapped). */
  sourceDurationMs: number;
  onSeek: (ms: number) => void;
  tool: TimelineTool;
  onToolChange: (tool: TimelineTool) => void;
  /** The Camera tab's global "hidden" toggle — while on, per-segment camera visibility
   *  is moot, so the Camera track goes non-interactive rather than editing dead settings. */
  cameraHidden: boolean;
  /** False for a recording with no separate camera file at all — the Camera track then
   *  has nothing real to edit (effectiveClips' empty-array default would otherwise still
   *  draw a full-width piece there, implying a camera track that doesn't exist), so it
   *  renders inert with no piece drawn, keeping only the row's own "Camera" label. */
  hasCamera: boolean;
  /** How far into `sourceDurationMs` the Camera track's own recorded source file actually
   *  starts — see EditProjectMedia.sideClipStartOffsetMs. Used as the unedited Camera
   *  track's default piece position (see cameraClipsList), so a fresh project's timeline
   *  reflects where that footage actually begins instead of implying it starts at 0. */
  cameraStartOffsetMs?: number | null;
  /** How long the recording's own footage runs on the edited timeline, measured by
   *  PreviewCompositor (see its onTimeUpdate) — the shorter of what's left of the screen
   *  file once its camera-less lead-in is trimmed and how much camera footage there actually
   *  is. Only that component can know the second half of it: the camera file's real duration
   *  has to be read off a loaded `<video>`, and this one has none. Used in place of the
   *  screen-only approximation below so both tracks' *default* (uncut) pieces are drawn
   *  exactly as long as they actually play. 0 until the first frame is drawn, which is what
   *  the fallback covers. */
  alignedFootageLengthMs?: number;
  /** Same recorded-cursor-track file PreviewCompositor reads for its live cursor overlay —
   *  fetched independently here just for its `clicks` timestamps, to drive the "auto zoom
   *  on clicks" magic button below. */
  cursorMetadataPath?: string | null;
  /** True only for a project that's never had a Timeline edit saved (see EditPage's
   *  `timelineLoadedForIdRef`/`project.timeline`) — runs the same "auto zoom on clicks"
   *  logic the magic-wand button does, once, as soon as click data finishes loading, so a
   *  freshly recorded project opens with its zoom track already populated instead of empty.
   *  Never fires again after that (see autoZoomAppliedRef below), so it can't clobber edits
   *  on a later reopen. */
  autoZoomOnLoad?: boolean;
  /** Set by EditPage when a chip-rail selection (Master/Cut N, or Zoom N) changes, so the
   *  Timeline highlights the matching piece — one-directional (panel → timeline); the
   *  Timeline's own `selection` state stays local otherwise. Consumed once (selectOnly +
   *  onFocusConsumed) rather than staying "live," so it doesn't fight normal in-timeline
   *  clicking afterward. */
  focusRequest?: { track: TrackKind; id: string } | null;
  onFocusConsumed?: () => void;
  /** The active edit tab, mapped to its track — highlights that row so it's obvious which
   *  track the open panel is editing. Purely a CSS class; every row stays interactive
   *  regardless of which tab is active, same as today. */
  activeTrack?: TrackKind;
  /** The reverse direction of focusRequest — fires whenever the Timeline's own selection
   *  becomes exactly one piece (a plain click, Ctrl/Cmd+click down to one, or a marquee
   *  that lands on a single piece), so EditPage can switch to that track's tab and select
   *  the matching cut/zoom there too. Silent for an empty selection or a multi-selection —
   *  "on selecting" means one specific thing became the focus, not a batch. */
  onSoleSelect?: (track: TrackKind, id: string) => void;
  /** The project's added-media pool (EditProject.media) — what the Video/Audio tracks'
   *  pieces resolve their `mediaId` against, for the file name shown on each piece and for
   *  the source length a trim handle is allowed to reveal back out to. A piece whose item
   *  is gone (removed from the pool in the Media panel) still draws, labelled as missing,
   *  so it can be seen and deleted rather than silently vanishing. */
  mediaItems: EditProjectMediaItem[];
  /** Files dropped straight onto the Video/Audio track from outside the app (Explorer/
   *  Finder), which have to join the pool before a piece can be placed from them — the
   *  Timeline has nowhere to persist that, so EditPage does the adding and the placing
   *  (see its own handleAddMediaFiles). Dragging an item that's *already* in the pool from
   *  the Media panel doesn't go through here: the Timeline places that itself. */
  onAddMediaFiles?: (filePaths: string[], atMs: number) => void;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function msToPct(ms: number, durationMs: number): number {
  return durationMs > 0 ? clamp01(ms / durationMs) * 100 : 0;
}

// Rounded to a whole ms — every drag/cut position on the timeline traces back to this, and
// leaving it a raw float let the Clips/Cursor link (cutClipsAndCursorAt and friends) drift
// out of exact-match sync: a Clips split's timelineStart is computed by round-tripping
// through sourceMs (sourceStart + (editedMs - timelineStart), then back), which in floating
// point doesn't always reproduce *exactly* the same value it started from — off by a
// fraction of a millisecond, just enough to fail a `===` boundary check on the next drag.
// Sub-millisecond precision has no meaning here anyway; rounding makes every position an
// exact integer, so that arithmetic really is associative and the two tracks can't drift.
function pctToMs(clientX: number, el: HTMLElement, durationMs: number): number {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return 0;
  return Math.round(clamp01((clientX - rect.left) / rect.width) * durationMs);
}

// Exact-match boundary comparison for the Clips/Cursor link (see cutClipsAndCursorAt and
// every linkedCursorSegIds/linkedClipIds filter below) — a sub-ms tolerance rather than
// strict `===`, as a defensive margin against any position that predates pctToMs's own
// rounding (or reaches this comparison through some other unrounded path) still comparing
// exact. Anything genuinely unrelated differs by way more than a millisecond, so this can't
// widen the match into the "any overlap" bug the exact-match check itself was fixing.
function msEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 1;
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSecs = ms / 1000;
  const m = Math.floor(totalSecs / 60);
  const s = Math.floor(totalSecs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Short "1.2s" form used for the always-visible start–end label burned onto each Clips/
// Camera piece — formatTime's m:ss is what the hover title still uses, but at a piece's
// usual on-screen width there's only room for something this compact.
function formatTimeSecs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  return `${(ms / 1000).toFixed(1)}s`;
}

// Full hh:mm:ss, for the ruler's end label — the one place the recording's *total* length is
// spelled out, so unlike the ticks' running m:ss it stays unambiguous past an hour.
function formatHms(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00:00";
  const totalSecs = Math.floor(ms / 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(Math.floor(totalSecs / 3600))}:${pad(Math.floor((totalSecs % 3600) / 60))}:${pad(totalSecs % 60)}`;
}

// Picks a "nice" tick spacing that lands roughly 6-10 ticks across the ruler.
const TICK_STEPS_MS = [500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000];
function pickTickStepMs(durationMs: number): number {
  const target = durationMs / 8;
  return TICK_STEPS_MS.find((s) => s >= target) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
}

function newId(): string {
  return crypto.randomUUID();
}

// Piece-to-piece drag snapping (Clips-to-Clips, Camera-to-Camera — the two tracks are
// otherwise fully independent, so a Clips piece never snaps onto a Camera one here). Pulls
// a dragged/trimmed edge flush onto whichever neighbor edge on the same track it's closest
// to, within tolerance, so a piece can be dropped exactly touching another — no gap, no
// overlap — instead of hand-aligning pixel by pixel.
function snapMoveToNeighbors(
  pieces: TimelineClip[],
  selfId: string,
  desiredStart: number,
  durationOfSelf: number,
  toleranceMs: number
): { start: number; touchId: string | null } {
  let bestDist = toleranceMs;
  let start = desiredStart;
  let touchId: string | null = null;
  const desiredEnd = desiredStart + durationOfSelf;
  for (const p of pieces) {
    if (p.id === selfId) continue;
    const pStart = p.timelineStart;
    const pEnd = p.timelineStart + (p.sourceEnd - p.sourceStart);
    const dLeft = Math.abs(desiredStart - pEnd);
    if (dLeft < bestDist) {
      bestDist = dLeft;
      start = pEnd;
      touchId = p.id;
    }
    const dRight = Math.abs(desiredEnd - pStart);
    if (dRight < bestDist) {
      bestDist = dRight;
      start = pStart - durationOfSelf;
      touchId = p.id;
    }
  }
  return { start: Math.max(0, start), touchId };
}
function snapEdgeToNeighbors(
  pieces: TimelineClip[],
  selfId: string,
  desiredMs: number,
  toleranceMs: number
): { ms: number; touchId: string | null } {
  let bestDist = toleranceMs;
  let ms = desiredMs;
  let touchId: string | null = null;
  for (const p of pieces) {
    if (p.id === selfId) continue;
    for (const edge of [p.timelineStart, p.timelineStart + (p.sourceEnd - p.sourceStart)]) {
      const d = Math.abs(desiredMs - edge);
      if (d < bestDist) {
        bestDist = d;
        ms = edge;
        touchId = p.id;
      }
    }
  }
  return { ms, touchId };
}
// Same pair, for Cursor — the one segment track with a free position (see
// handleCursorSegmentPointerDown/handleCursorSegmentEdgePointerDown). Identical algorithm to
// snapMoveToNeighbors/snapEdgeToNeighbors above, just against {id, startMs, endMs} instead of
// TimelineClip's timelineStart/sourceStart/sourceEnd — segments have no separate source
// range to carry along.
function snapSegmentMoveToNeighbors(
  segments: { id: string; startMs: number; endMs: number }[],
  selfId: string,
  desiredStart: number,
  durationOfSelf: number,
  toleranceMs: number
): { start: number; touchId: string | null } {
  let bestDist = toleranceMs;
  let start = desiredStart;
  let touchId: string | null = null;
  const desiredEnd = desiredStart + durationOfSelf;
  for (const s of segments) {
    if (s.id === selfId) continue;
    const dLeft = Math.abs(desiredStart - s.endMs);
    if (dLeft < bestDist) {
      bestDist = dLeft;
      start = s.endMs;
      touchId = s.id;
    }
    const dRight = Math.abs(desiredEnd - s.startMs);
    if (dRight < bestDist) {
      bestDist = dRight;
      start = s.startMs - durationOfSelf;
      touchId = s.id;
    }
  }
  return { start: Math.max(0, start), touchId };
}
function snapSegmentEdgeToNeighbors(
  segments: { id: string; startMs: number; endMs: number }[],
  selfId: string,
  desiredMs: number,
  toleranceMs: number
): { ms: number; touchId: string | null } {
  let bestDist = toleranceMs;
  let ms = desiredMs;
  let touchId: string | null = null;
  for (const s of segments) {
    if (s.id === selfId) continue;
    for (const edge of [s.startMs, s.endMs]) {
      const d = Math.abs(desiredMs - edge);
      if (d < bestDist) {
        bestDist = d;
        ms = edge;
        touchId = s.id;
      }
    }
  }
  return { ms, touchId };
}

/** Snaps a dragged piece so that whichever of its *two* edges is closest to an alignment
 *  point lands exactly on it — the piece stops there, then carries on once the pointer pulls
 *  past the tolerance. Both edges compete on equal footing (unlike snapMoveToNeighbors,
 *  which only ever aligns against same-track neighbours): lining a piece's *end* up with a
 *  cut is exactly as common as lining up its start. Candidates that would push the piece
 *  before 0 are dropped rather than clamped, so the returned `guideMs` is always the point
 *  actually landed on — that's what the alignment guide line is drawn at. `guideMs` null
 *  means nothing was within tolerance and `start` is the untouched desired position. */
function snapMoveToPoints(
  points: number[],
  desiredStart: number,
  durationOfSelf: number,
  toleranceMs: number
): { start: number; guideMs: number | null } {
  let bestDist = toleranceMs;
  let start = desiredStart;
  let guideMs: number | null = null;
  const desiredEnd = desiredStart + durationOfSelf;
  for (const p of points) {
    const dLeft = Math.abs(desiredStart - p);
    if (dLeft < bestDist) {
      bestDist = dLeft;
      start = p;
      guideMs = p;
    }
    const dRight = Math.abs(desiredEnd - p);
    if (dRight < bestDist && p - durationOfSelf >= 0) {
      bestDist = dRight;
      start = p - durationOfSelf;
      guideMs = p;
    }
  }
  return { start: Math.max(0, start), guideMs };
}

// Cursor is set on <body> directly for the duration of a drag rather than relying on
// CSS :active — with pointer capture in play the pointer routinely ends up outside the
// dragged element's own box, and :active doesn't reliably survive that everywhere.
function setDragCursor(cursor: string) {
  document.body.style.cursor = cursor;
}

export function Timeline({
  timeline,
  onChange,
  currentMs,
  durationMs: durationMsProp,
  sourceDurationMs,
  onSeek,
  tool,
  onToolChange,
  cameraHidden,
  hasCamera,
  cameraStartOffsetMs,
  alignedFootageLengthMs,
  cursorMetadataPath,
  autoZoomOnLoad,
  focusRequest,
  onFocusConsumed,
  activeTrack,
  onSoleSelect,
  mediaItems,
  onAddMediaFiles,
}: TimelineProps) {
  // The edited timeline's own extent (durationMsProp) is derived from clips/cameraClips —
  // it legitimately drops to 0 when every piece on both tracks has been deleted (e.g. via
  // select-all + Delete), even though a recording is still loaded. Falling back to the raw
  // recording's own length in that case keeps the toolbar/ruler/tracks on screen (as an
  // empty, fully-gapped timeline the source's full length) instead of the whole editor UI
  // collapsing to the "no recording loaded" placeholder below.
  const durationMs = durationMsProp > 0 ? durationMsProp : sourceDurationMs;
  // Every currently-selected piece across all three tracks, as `${track}:${id}` keys — see
  // keyOf/isSelected/selectOnly/toggleSelect/clearSelection below. A plain click replaces
  // the selection with just that piece; Ctrl/Cmd+click toggles one piece in/out of it;
  // marquee-dragging over empty track space (see startMarquee) selects everything the box
  // touches, across tracks. Delete/Backspace (handleDeleteShortcutRef below) removes
  // whatever's in here; dragging any selected piece's body while others are also selected
  // (see startGroupDrag) moves the whole set together.
  const [selection, setSelection] = useState<Set<string>>(new Set());
  function keyOf(track: TrackKind, id: string): string {
    return `${track}:${id}`;
  }
  function isSelected(track: TrackKind, id: string): boolean {
    return selection.has(keyOf(track, id));
  }
  function selectOnly(track: TrackKind, id: string) {
    setSelection(new Set([keyOf(track, id)]));
  }
  function toggleSelect(track: TrackKind, id: string) {
    setSelection((prev) => {
      const k = keyOf(track, id);
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  function clearSelection() {
    setSelection(new Set());
  }
  // Called wherever a piece is removed via its own delete button, so a stale key for it
  // never lingers in the selection set.
  function discardFromSelection(track: TrackKind, id: string) {
    const k = keyOf(track, id);
    setSelection((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
  }
  // Recorded click timestamps (raw source ms) for the "auto zoom on clicks" magic button —
  // null while unloaded/unavailable, distinct from an empty array (loaded, but the
  // recording genuinely has no clicks), so the button can tell "still loading" from
  // "nothing to work with" and word its title accordingly.
  const [clicksSourceMs, setClicksSourceMs] = useState<number[] | null>(null);
  // Each click's on-screen position (frame pixel coords, same space PreviewCompositor's own
  // cursor-follow crop works in), parallel to clicksSourceMs by index — null entries where
  // no cursor sample was found nearby. Lets computeAutoZooms tell "two clicks close in time
  // but far apart on screen" from "two clicks on roughly the same spot" (see its own
  // SPATIAL_SPLIT_FRAC). clickFrame is that same space's own dimensions, for turning a raw
  // pixel distance into a fraction of the frame.
  const [clickPositions, setClickPositions] = useState<({ x: number; y: number } | null)[] | null>(null);
  const [clickFrame, setClickFrame] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    setClicksSourceMs(null);
    setClickPositions(null);
    setClickFrame(null);
    if (!cursorMetadataPath) return;
    let cancelled = false;
    (async () => {
      try {
        const metadata: CursorMetadata = await (await fetch(mediaUrl(cursorMetadataPath))).json();
        if (cancelled) return;
        const clicks = metadata.clicks ?? [];
        setClicksSourceMs(clicks);
        setClickFrame(frameDimensions(metadata));
        const points = metadata.points;
        setClickPositions(
          clicks.map((ms) => {
            if (!points || points.length === 0) return null;
            // Nearest recorded cursor sample at or before this click's own timestamp —
            // same binary search PreviewCompositor's own live cursor-follow uses.
            let lo = 0;
            let hi = points.length - 1;
            let idx = 0;
            while (lo <= hi) {
              const mid = (lo + hi) >> 1;
              if (points[mid].t <= ms) {
                idx = mid;
                lo = mid + 1;
              } else {
                hi = mid - 1;
              }
            }
            const p = points[idx];
            return toFrameCoords(metadata, p.x, p.y);
          })
        );
      } catch {
        // No cursor track for this recording — the magic button just stays disabled.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cursorMetadataPath]);
  // Fires autoZoomFromClicks (below) exactly once, as soon as both click data *and* the
  // video's own duration have finished loading, for a project that's opening with no saved
  // Timeline edits at all — see autoZoomOnLoad's own doc comment. Click data (a small local
  // JSON fetch) routinely resolves well before durationMs does (the <video> element's own
  // metadata load) — marking this "done" as soon as clicks loaded, without waiting on
  // durationMs too, let autoZoomFromClicks's own `durationMs <= 0` guard silently no-op the
  // very first (only) attempt, permanently skipping it for the rest of the session. Guarded
  // on `timeline.zooms.length === 0` too, purely defensively, so this can never clobber
  // zoom blocks that (somehow) already exist by the time both are ready.
  const autoZoomAppliedRef = useRef(false);
  useEffect(() => {
    if (!autoZoomOnLoad || autoZoomAppliedRef.current || clicksSourceMs === null) return;
    if (clicksSourceMs.length === 0) {
      autoZoomAppliedRef.current = true; // nothing to zoom to — give up for good
      return;
    }
    if (durationMs <= 0) return; // clicks are in, but the video's own duration isn't yet — wait
    autoZoomAppliedRef.current = true;
    if (timeline.zooms.length > 0) return;
    autoZoomFromClicks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoZoomOnLoad, clicksSourceMs, durationMs]);
  // Which Clips/Camera piece the pointer is currently over — neither track has a
  // persistent selection (hovering already surfaces its own Delete button), but
  // Delete/Backspace still needs *something* to target, so it acts on whichever piece is
  // hovered.
  const [hoveredClipId, setHoveredClipId] = useState<string | null>(null);
  const [hoveredCameraClipId, setHoveredCameraClipId] = useState<string | null>(null);
  // While the cut tool hovers one track, this is where the cut would land if the pointer
  // is close enough to snap onto a cut boundary already sitting on any *other* track — a
  // preview of "cut here and it'll line up with that one," shown before the click happens.
  // Every cuttable track takes part (see crossTrackBoundaryPoints), not just Clips/Camera:
  // the tracks that already have a cut at that exact ms draw their own marker there too, so
  // it's clear *which* cut this one would line up with (see snapTargetTracks).
  const [cutGuide, setCutGuide] = useState<{ track: TrackKind; ms: number } | null>(null);
  // How much wider than its container the timeline draws itself — purely a view setting (how
  // far in the ruler is scrolled/magnified), nothing to do with the Zoom *track*'s own
  // zoom-in effects. 1 is fit-to-width, the way this has always rendered; anything above
  // that overflows .tl-root, which scrolls. Everything inside a track positions itself as a
  // percentage of that track's own width, so widening the rows is all it takes for pieces,
  // ticks, the playhead and the cut guides to spread out with it.
  const [viewZoom, setViewZoom] = useState(1);
  // toFixed rounds off the float drift a repeated += 0.5 from 0.9 otherwise accumulates,
  // which would keep the slider's own value from ever landing back on a clean step.
  function stepViewZoom(direction: 1 | -1) {
    setViewZoom((z) => clamp(Number((z + direction * VIEW_ZOOM_BUTTON_STEP).toFixed(2)), VIEW_ZOOM_MIN, VIEW_ZOOM_MAX));
  }
  // While dragging (moving or edge-trimming) a Clips/Camera piece, which other piece on
  // that same track it's currently snapped flush against (no gap, no overlap) — both the
  // dragged piece and its neighbor get a highlight so the touch is obvious mid-drag.
  const [clipSnapPair, setClipSnapPair] = useState<{ dragged: string; touching: string } | null>(null);
  const [cameraSnapPair, setCameraSnapPair] = useState<{ dragged: string; touching: string } | null>(null);
  // Same, for Cursor — the one segment track with a free position to drag/trim (see
  // handleCursorSegmentPointerDown/handleCursorSegmentEdgePointerDown).
  const [cursorSnapPair, setCursorSnapPair] = useState<{ dragged: string; touching: string } | null>(null);
  // Same-track "flush against a neighbour" highlight for the Zoom and Effects rows — the
  // one thing those blocks were missing next to Clips/Camera/Cursor, which have had it all
  // along (see clipSnapPair). Both keep the dragged block's own track alongside the pair so
  // the Callout and Blur rows can't light each other's blocks up.
  const [zoomSnapPair, setZoomSnapPair] = useState<{ dragged: string; touching: string } | null>(null);
  const [effectSnapPair, setEffectSnapPair] = useState<{ track: EffectTrackKind; dragged: string; touching: string } | null>(null);
  // Same, for whichever media track is being dragged on — one piece of state rather than
  // one per track, since only ever one drag is in flight at a time.
  const [mediaSnapPair, setMediaSnapPair] = useState<{ track: MediaTrackKind; dragged: string; touching: string } | null>(null);
  // Live "it'll land here" feedback while a media file (from the Media panel, or straight
  // from the OS) is dragged over a media track — the track lights up and a marker shows the
  // drop position. Cleared on drop/leave. HTML5 drag-and-drop, not the pointer-event drags
  // everything else in this component uses: the source is a DOM element in another pane
  // (or another application entirely), which pointer capture can't span.
  const [mediaDropTarget, setMediaDropTarget] = useState<{ track: MediaTrackKind; ms: number } | null>(null);
  // Where a piece currently being dragged (moved or edge-trimmed) on any of the four
  // free-positioned tracks — Clips, Camera, Ext Video, Ext Audio — has snapped one of its
  // edges onto a boundary belonging to some *other* track: the ms it landed on, plus which
  // piece did the landing. Drives the alignment guide drawn across every track that shares
  // that boundary (see alignGuide/renderCutGuide) and the dragged piece's own snap
  // highlight. Null whenever the drag is free of any cross-track boundary.
  const [dragSnap, setDragSnap] = useState<{ track: TrackKind; id: string; ms: number } | null>(null);

  const rulerRef = useRef<HTMLDivElement>(null);
  const clipsTrackRef = useRef<HTMLDivElement>(null);
  const zoomTrackRef = useRef<HTMLDivElement>(null);
  const calloutTrackRef = useRef<HTMLDivElement>(null);
  const blurTrackRef = useRef<HTMLDivElement>(null);
  const cameraTrackRef = useRef<HTMLDivElement>(null);
  const cursorTrackRef = useRef<HTMLDivElement>(null);
  const layoutTrackRef = useRef<HTMLDivElement>(null);
  const videoTrackRef = useRef<HTMLDivElement>(null);
  const audioTrackRef = useRef<HTMLDivElement>(null);
  // Wraps the ruler + Clips/Zoom/Camera rows — the coordinate frame the marquee
  // selection box (see startMarquee) is positioned relative to, and the boundary the
  // outside-click effect below uses to tell "clicked elsewhere in the timeline" (never
  // clears selection) from "clicked elsewhere in the app entirely" (does).
  const tlInnerRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  // A drag is only really a drag once the pointer has moved this far from where it went
  // down — short of that, pointerup is treated as a plain click (select/toggle) instead of
  // whatever the drag would have done (move a piece, marquee-select).
  const DRAG_THRESHOLD_PX = 4;
  const zoomDragRef = useRef<{
    id: string; grabOffsetMs: number; moved: boolean; downX: number; downY: number; wasSoleSelected: boolean;
  } | null>(null);
  const zoomTrimDragRef = useRef<{ id: string; edge: "left" | "right" } | null>(null);
  // Effects blocks (Callout/Blur) drag and trim exactly like zoom blocks do — same refs,
  // plus the track the drag started on so the shared handlers know which row's element to
  // measure the pointer against.
  const effectDragRef = useRef<{
    track: EffectTrackKind; id: string; grabOffsetMs: number;
    moved: boolean; downX: number; downY: number; wasSoleSelected: boolean;
  } | null>(null);
  const effectTrimDragRef = useRef<{ track: EffectTrackKind; id: string; edge: "left" | "right" } | null>(null);
  // Dragging a Clips piece by its body moves it (its own timelineStart) freely; grabbing
  // an edge instead trims that side, revealing (or hiding) source footage — see
  // handleClipEdgePointerMove. The Camera track's pieces work identically, just backed by
  // `timeline.cameraClips` instead of `timeline.clips` — see handleCameraClipBodyPointerDown
  // et al below. `moved`/`downX`/`downY` distinguish a plain click (toggles selection) from
  // a real drag (moves the piece, leaves selection alone); `wasSoleSelected` records whether
  // this piece was already the only thing selected *before* this pointerdown, so a
  // no-movement pointerup on it can tell "just became sole-selected" from "already was,
  // toggle it back off" — see handleClipBodyPointerUp.
  const clipDragRef = useRef<{
    id: string; grabOffsetMs: number; moved: boolean; downX: number; downY: number; wasSoleSelected: boolean;
    // Cursor segment(s) whose [startMs, endMs) exactly matched this clip's own span at
    // drag-start (see cutClipsAndCursorAt's own comment on why Clips/Cursor stay linked) —
    // an exact match, not "any overlap", so a drag doesn't sweep up unrelated Cursor
    // segments that merely happen to overlap the clip (e.g. from cuts made before this link
    // existed). Since they start exactly where the clip does, they track it 1:1 with no
    // offset math needed — just carried to the clip's own new position each move.
    linkedCursorSegIds: string[];
  } | null>(null);
  // linkedCursorSegIds: whichever Cursor segment(s) had an edge exactly on the boundary
  // being trimmed at drag-start (see handleClipEdgePointerDown) — kept in lockstep the same
  // way a whole-piece move is (see clipDragRef's own linkedCursorSegIds), just one edge at a
  // time instead of the whole segment.
  const clipTrimDragRef = useRef<{ id: string; edge: "left" | "right"; linkedCursorSegIds: string[] } | null>(null);
  // Cursor is the one segment track that can be dragged (see handleCursorSegmentPointerDown)
  // — Layout stays cut-only. `linkedClipIds` mirrors clipDragRef's own linkedCursorSegIds,
  // just in the other direction: whichever Clips piece(s) had a span that exactly matched
  // this segment's own [startMs, endMs) at drag-start (not "any overlap" — see
  // handleCursorSegmentPointerDown's own comment for why).
  const cursorSegDragRef = useRef<{
    id: string; grabOffsetMs: number; moved: boolean; downX: number; downY: number; wasSoleSelected: boolean;
    linkedClipIds: string[];
  } | null>(null);
  // Cursor's own edge-trim handles (see handleCursorSegmentEdgePointerDown) — mirrors
  // clipTrimDragRef's linkedCursorSegIds, just in the other direction: whichever Clips
  // piece(s) had an edge exactly on the boundary being trimmed at drag-start.
  const cursorSegTrimDragRef = useRef<{ id: string; edge: "left" | "right"; linkedClipIds: string[] } | null>(null);
  const cameraClipDragRef = useRef<{
    id: string; grabOffsetMs: number; moved: boolean; downX: number; downY: number; wasSoleSelected: boolean;
  } | null>(null);
  const cameraClipTrimDragRef = useRef<{ id: string; edge: "left" | "right" } | null>(null);
  // The Video/Audio tracks share one pair of drag refs (rather than two more each, as
  // Clips/Camera have) — the handlers below are track-parameterized, so which track a drag
  // belongs to is data, not a separate code path.
  const mediaClipDragRef = useRef<{
    track: MediaTrackKind; id: string; grabOffsetMs: number; moved: boolean; downX: number; downY: number; wasSoleSelected: boolean;
  } | null>(null);
  const mediaClipTrimDragRef = useRef<{ track: MediaTrackKind; id: string; edge: "left" | "right" } | null>(null);
  // Moving every selected piece together — set up on pointerdown when the piece grabbed is
  // already part of a multi-selection (see startGroupDrag), instead of the single-piece drag
  // refs above. `items` snapshots each selected piece's own startMs at drag start so the
  // whole group can be shifted by one shared delta without drift; `maxStartMs` (Zoom items
  // only) keeps a block from being dragged past the end of the timeline, since unlike
  // Clips/Camera pieces a Zoom block can't extend the timeline itself.
  const groupDragRef = useRef<{
    originMs: number;
    downX: number;
    downY: number;
    moved: boolean;
    clickedTrack: TrackKind;
    clickedId: string;
    items: { track: TrackKind; id: string; startMs: number; maxStartMs?: number }[];
  } | null>(null);
  // The in-progress marquee-select drag, if any — see startMarquee/handleMarqueeMove/
  // handleMarqueeUp. `active` flips true once the pointer clears DRAG_THRESHOLD_PX, same
  // click-vs-drag distinction as the piece drags above; `addMode` (Ctrl/Cmd/Shift held at
  // drag start) adds the box's contents to the existing selection instead of replacing it.
  const marqueeRef = useRef<{ downX: number; downY: number; curX: number; curY: number; active: boolean; addMode: boolean } | null>(null);
  // Whether the marquee drag that just ended actually swept a box. Pointer capture sends
  // the trailing `click` back to the track the drag *started* on however far it travelled,
  // so without this a rubber-band select begun on a block-dropping track (Zoom, Callout,
  // Blur) would also drop a block when it finished. Set on pointerup, consumed by those
  // tracks' own click handlers, cleared at the start of the next press. Declared here
  // (rather than beside startMarquee, which is defined below this component's early "no
  // clip loaded yet" return) so this hook always runs, whichever way that return goes —
  // a hook declared only on one side of it is exactly what breaks React's hook-order rule.
  const marqueeDraggedRef = useRef(false);
  const [marqueeBox, setMarqueeBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // Frozen at the start of a Clips/Camera piece drag (move or edge-trim) — `durationMs`
  // isn't a fixed value, it's recomputed every animation frame from the live clip data
  // (see PreviewCompositor's draw loop), including whatever's mid-drag. Without freezing
  // it, dragging/expanding whichever piece currently defines the *overall* timeline length
  // feeds its own growth straight back into the pixel↔ms scale used to interpret that same
  // drag's pointer position — every render, the same on-screen pointer position maps to a
  // different ms, snowballing into runaway growth or collapse instead of tracking the
  // pointer normally. Dragging any other piece never moves `durationMs`, which is exactly
  // why only the piece currently at the far edge of its track shows this.
  const dragDurationMsRef = useRef(durationMs);
  // Reassigned fresh below on every render (after the delete helper it calls is declared)
  // so the one, never-resubscribed keydown listener below always acts on whatever's
  // currently selected, without re-subscribing on every timeline edit.
  const handleDeleteShortcutRef = useRef<() => boolean>(() => false);
  // Same pattern, for Ctrl/Cmd+A — see selectAll below.
  const handleSelectAllRef = useRef<() => void>(() => {});
  // Whether the pointer's last mousedown anywhere in the app landed inside the timeline
  // widget — mirrored by the outside-click effect further down, which already does this
  // exact containment check for clearing the selection. Ctrl/Cmd+A only selects everything
  // when this is true, so it doesn't hijack "select all" in some other focused input/panel.
  const timelineFocusedRef = useRef(false);

  // Delete/Backspace — removes every selected piece (see `selection`), falling back to
  // whatever Clips/Camera piece is hovered if nothing's selected. Ctrl/Cmd+A selects every
  // piece across all three tracks, but only while the timeline is the last thing clicked
  // (see timelineFocusedRef) — otherwise it's left alone to do whatever it normally does
  // elsewhere (e.g. select all text in a focused field). Both only preventDefault when they
  // actually did something, so Backspace still falls through to its usual behavior
  // otherwise, and Ctrl+A still selects page text when the timeline isn't focused.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {
        if (!timelineFocusedRef.current) return;
        e.preventDefault();
        handleSelectAllRef.current();
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (handleDeleteShortcutRef.current()) e.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Safety net for setDragCursor — a drag's own pointerup is the normal way the cursor
  // override gets cleared, but if the pointer is released outside the window, capture gets
  // lost, or the window loses focus mid-drag, that pointerup can be missed entirely and
  // leave the whole app stuck showing e.g. "grabbing". These fire regardless of which
  // element (if any) still thinks it owns the drag.
  useEffect(() => {
    function clear() {
      setDragCursor("");
      setDragSnap(null);
    }
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // A guide left over from cutting mode shouldn't linger once the tool switches away.
  useEffect(() => {
    if (tool !== "cut") setCutGuide(null);
  }, [tool]);

  // EditPage sets `focusRequest` whenever a chip-rail selection (Master/Cut N, Zoom N)
  // changes, so the matching piece highlights here too — one-directional (panel →
  // timeline). Consumed immediately via onFocusConsumed so it doesn't fight normal
  // in-timeline clicking afterward.
  useEffect(() => {
    if (!focusRequest) return;
    selectOnly(focusRequest.track, focusRequest.id);
    onFocusConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // The reverse direction — clicking (or marquee-selecting down to) exactly one piece
  // anywhere in the Timeline tells EditPage to switch to that track's tab and select the
  // matching cut/zoom there, so its settings show in the panel above. Silent while the
  // selection is empty or spans more than one piece.
  useEffect(() => {
    if (selection.size !== 1) return;
    const [key] = selection;
    const idx = key.indexOf(":");
    onSoleSelect?.(key.slice(0, idx) as TrackKind, key.slice(idx + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  // Tracks timelineFocusedRef (for Ctrl/Cmd+A above) on every mousedown in the app, and —
  // when that mousedown landed outside the whole timeline widget (the preview canvas, other
  // tabs, and so on) — clears the selection too, including closing a sole-selected Zoom
  // block's pct/remove toolbar. Clicks *inside* the timeline (tracks, pieces, the toolbar
  // itself) are left entirely to the track-level handlers below, which already manage
  // selection correctly there (including Ctrl/Cmd-drag adding to it) — this only needs to
  // catch the rest. A ref (mirrored every render) rather than a `selection`-keyed effect so
  // this subscribes once instead of on every selection change.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const inside = !!(tlInnerRef.current && tlInnerRef.current.contains(e.target as Node));
      timelineFocusedRef.current = inside;
      if (!inside && selectionRef.current.size > 0) clearSelection();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  if (sourceDurationMs <= 0) {
    return (
      <div className="tl-empty">
        <span className="tl-empty-icon">🎬</span>
        <span>Load a clip to start cutting and adding zooms.</span>
      </div>
    );
  }

  // `effectiveClips` treats an empty clips/cameraClips array as "not edited yet" and
  // fabricates one clip spanning the whole recording (see its own doc comment) — so writing
  // `[]` back after deleting the *last* piece on a track would silently undo the deletion,
  // reviving that full clip next render instead of leaving the track empty. Wrap every
  // deletion's result through this first: a zero-width placeholder keeps the array
  // non-empty (skipping the fabrication) while behaving exactly like a real gap everywhere
  // else — resolveClipAt never matches it, it draws as nothing, and it contributes 0 to the
  // track's own extent (totalClipsExtentMs).
  function emptiedTrack(next: TimelineClip[]): TimelineClip[] {
    return next.length > 0 ? next : [{ id: newId(), sourceStart: 0, sourceEnd: 0, timelineStart: 0 }];
  }

  // Clips track — each piece has its own independent `timelineStart` (shared/lib/
  // timelineClips.ts), completely decoupled from the others — dragging one never shifts,
  // ripples, or reorders anything else. Pieces can freely overlap; the one most recently
  // grabbed is brought to the front of the array so it's what's on top (and what plays)
  // wherever it now overlaps another. A stretch nothing covers is a real gap — plays as
  // silent background, not skipped.
  function updateClips(next: TimelineClip[]) {
    onChange({ ...timeline, clips: next });
  }
  // Shared by both tracks' default (unedited) pieces so they start *and* end together —
  // see effectiveClips' own doc comment. PreviewCompositor measures this properly (it can
  // read the camera file's real duration off a loaded <video>; this component has no such
  // element) and reports it back as alignedFootageLengthMs, so the pieces drawn here are
  // exactly as long as the ones that actually play. The screen-only approximation below is
  // just the fallback for the frames before that first measurement arrives — it overstates
  // the length whenever the camera file is the shorter of the two, which used to show up as
  // an Ext Video/Ext Audio piece appended "at the end" visibly overlapping the footage
  // pieces it was meant to start after.
  const alignedLengthMs =
    alignedFootageLengthMs && alignedFootageLengthMs > 0
      ? alignedFootageLengthMs
      : Math.max(0, sourceDurationMs - (cameraStartOffsetMs ?? 0));
  function clipsList(): TimelineClip[] {
    return effectiveClips(timeline.clips, sourceDurationMs, 0, alignedLengthMs, cameraStartOffsetMs ?? 0);
  }
  // How far the *recording* itself reaches — the rightmost edge of the Clips and Camera
  // tracks, ignoring the added-media ones. This, not `durationMs`, is what the config-only
  // tracks (Cursor/Layout) tile: they describe how the recording is composited, and past
  // the end of the footage there's no recording left for them to describe — an Ext
  // Video/Ext Audio piece dropped after the end would otherwise stretch both strips out
  // behind it. Pieces still *position* themselves against the full `durationMs`, so they stay
  // lined up with the ruler; they simply stop early. Falls back to `durationMs` if both
  // footage tracks are empty (every piece deleted), so the strips don't vanish entirely.
  const footageDurationMs =
    Math.max(totalClipsExtentMs(clipsList()), totalClipsExtentMs(cameraClipsList())) || durationMs;
  // How far the *Clips* track alone reaches — what the Cursor strip tiles, as against
  // `footageDurationMs` above, which the Layout strip tiles. The synthetic cursor is only
  // ever drawn over screen content (PreviewCompositor guards it on the same
  // showScreenContent as the recording itself) and its cuts stay linked to Clips pieces
  // throughout this file, so the Camera track has no say in it: including the camera's
  // extent here meant dragging a Camera piece out past the end of the screen recording
  // visibly stretched the uncut Cursor strip along with it, as though the two were linked.
  // Layout is different — it describes the whole canvas, camera bubble included — so it
  // still spans both. Same `|| durationMs` fallback, so an emptied track doesn't collapse
  // the strip to nothing.
  const cursorDurationMs = totalClipsExtentMs(clipsList()) || durationMs;

  // Snap tolerance, converted from a fixed on-screen pixel radius to ms using the track's
  // current rendered width — so it feels the same regardless of the recording's length.
  const CUT_SNAP_PX = 8;
  function cutSnapToleranceMs(trackEl: HTMLElement, durationMsForScale = durationMs): number {
    const width = trackEl.getBoundingClientRect().width;
    return width > 0 ? (CUT_SNAP_PX / width) * durationMsForScale : 0;
  }
  function nearestPointMs(points: number[], ms: number, toleranceMs: number): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    for (const p of points) {
      const dist = Math.abs(p - ms);
      if (dist <= toleranceMs && dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return best;
  }

  /** Every position on the rest of the timeline a dragged piece can align an edge to: every
   *  *other* track's cut boundaries — which is to say every piece, segment and zoom block's
   *  own start and end — plus the timeline's own two ends. crossTrackBoundaryPoints (what
   *  the *cut tool* snaps to) deliberately drops 0 and durationMs because nothing can be cut
   *  there; here they're among the most useful targets there are, since butting a piece
   *  flush against the start or the end of the video is one of the commonest things to want.
   *  Same-track neighbours are deliberately absent — those are handled by
   *  snapMoveToNeighbors/snapEdgeToNeighbors, which also light the neighbour itself up.
   *
   *  `timelineEndMs` is passed in frozen from the drag rather than read live, for exactly
   *  the reason dragDurationMsRef exists: dragging the piece that currently *defines* the
   *  timeline's end would otherwise chase its own snap target as the timeline grew under it. */
  function alignPointsForTrack(track: TrackKind, timelineEndMs = durationMs): number[] {
    const points: number[] = [0, timelineEndMs];
    for (const t of MATCHABLE_TRACKS) {
      if (t === track) continue;
      for (const it of matchableTrackItems(t)) points.push(it.startMs, it.endMs);
    }
    return Array.from(new Set(points));
  }

  /** The two pulls a dragged piece is subject to, resolved into one answer: flush against a
   *  neighbour on its own track (which also lights that neighbour up), or aligned with a
   *  boundary anywhere else on the timeline (which draws the cross-track guide). Whichever
   *  pulls harder wins; a same-track contact breaks an exact tie, being the more specific of
   *  the two intents. Shared by all four free-positioned tracks so they behave identically —
   *  `guideMs` non-null is what says the cross-track one won. */
  function resolveMoveSnap(
    track: TrackKind,
    pieces: TimelineClip[],
    selfId: string,
    desiredStart: number,
    durationOfSelf: number,
    toleranceMs: number,
    timelineEndMs: number
  ): { start: number; touchId: string | null; guideMs: number | null } {
    const neighbor = snapMoveToNeighbors(pieces, selfId, desiredStart, durationOfSelf, toleranceMs);
    const align = snapMoveToPoints(alignPointsForTrack(track, timelineEndMs), desiredStart, durationOfSelf, toleranceMs);
    const useAlign =
      align.guideMs !== null &&
      (neighbor.touchId === null || Math.abs(align.start - desiredStart) < Math.abs(neighbor.start - desiredStart));
    return useAlign
      ? { start: align.start, touchId: null, guideMs: align.guideMs }
      : { start: neighbor.start, touchId: neighbor.touchId, guideMs: null };
  }

  /** resolveMoveSnap's counterpart for an edge-trim drag — the dragged edge sits directly on
   *  the edited timeline, so it snaps to the same two families of target. */
  function resolveEdgeSnap(
    track: TrackKind,
    pieces: TimelineClip[],
    selfId: string,
    desiredMs: number,
    toleranceMs: number,
    timelineEndMs: number
  ): { ms: number; touchId: string | null; guideMs: number | null } {
    const neighbor = snapEdgeToNeighbors(pieces, selfId, desiredMs, toleranceMs);
    const alignMs = nearestPointMs(alignPointsForTrack(track, timelineEndMs), desiredMs, toleranceMs);
    const useAlign =
      alignMs !== null &&
      (neighbor.touchId === null || Math.abs(alignMs - desiredMs) < Math.abs(neighbor.ms - desiredMs));
    return useAlign
      ? { ms: alignMs!, touchId: null, guideMs: alignMs! }
      : { ms: neighbor.ms, touchId: neighbor.touchId, guideMs: null };
  }

  /** resolveMoveSnap/resolveEdgeSnap's counterpart for every track whose items are plain
   *  [startMs, endMs] spans rather than TimelineClips — Cursor segments, Zoom blocks, and the
   *  Callout/Blur blocks. Same two-target resolution (same-track neighbor vs. cross-track
   *  alignment), just against snapSegmentMoveToNeighbors/snapSegmentEdgeToNeighbors instead
   *  of the TimelineClip-typed originals, since none of those carry a source range. */
  function resolveSegmentMoveSnap(
    track: TrackKind,
    segments: { id: string; startMs: number; endMs: number }[],
    selfId: string,
    desiredStart: number,
    durationOfSelf: number,
    toleranceMs: number,
    timelineEndMs: number
  ): { start: number; touchId: string | null; guideMs: number | null } {
    const neighbor = snapSegmentMoveToNeighbors(segments, selfId, desiredStart, durationOfSelf, toleranceMs);
    const align = snapMoveToPoints(alignPointsForTrack(track, timelineEndMs), desiredStart, durationOfSelf, toleranceMs);
    const useAlign =
      align.guideMs !== null &&
      (neighbor.touchId === null || Math.abs(align.start - desiredStart) < Math.abs(neighbor.start - desiredStart));
    return useAlign
      ? { start: align.start, touchId: null, guideMs: align.guideMs }
      : { start: neighbor.start, touchId: neighbor.touchId, guideMs: null };
  }
  function resolveSegmentEdgeSnap(
    track: TrackKind,
    segments: { id: string; startMs: number; endMs: number }[],
    selfId: string,
    desiredMs: number,
    toleranceMs: number,
    timelineEndMs: number
  ): { ms: number; touchId: string | null; guideMs: number | null } {
    const neighbor = snapSegmentEdgeToNeighbors(segments, selfId, desiredMs, toleranceMs);
    const alignMs = nearestPointMs(alignPointsForTrack(track, timelineEndMs), desiredMs, toleranceMs);
    const useAlign =
      alignMs !== null &&
      (neighbor.touchId === null || Math.abs(alignMs - desiredMs) < Math.abs(neighbor.ms - desiredMs));
    return useAlign
      ? { ms: alignMs!, touchId: null, guideMs: alignMs! }
      : { ms: neighbor.ms, touchId: neighbor.touchId, guideMs: null };
  }

  // Clips and Cursor are kept in lockstep: cutting one cuts the other at the same edited-ms
  // point, and dragging one carries along whatever Cursor settings/Clips footage currently
  // shares that stretch (see handleClipBodyPointerDown, handleCursorSegmentPointerDown, and
  // startGroupDrag's own linking below). One combined onChange (not two updateClips/
  // updateCursorSegments calls) — separate calls would each read the same stale `timeline`
  // prop within this one synchronous handler, so only the second would actually stick.
  function cutClipsAndCursorAt(editedMs: number) {
    const clips = clipsList();
    const resolved = resolveClipAt(clips, editedMs);
    const newClips = resolved ? splitClipAtSource(clips, resolved.sourceMs) : clips;
    const newCursorSegments = splitSegmentAtPoint(timeline.cursorSegments, editedMs, cursorDurationMs);
    onChange({ ...timeline, clips: newClips, cursorSegments: newCursorSegments });
  }

  // Deleting a Clips ("screen") piece deletes whichever Cursor segment(s) exactly matched
  // its span too (a true removal — it leaves a gap, same as the deleted clip does, not
  // Cursor's own hover-delete-in-place — see hideCursorPiece) — one-way only. Deleting a
  // Cursor segment does *not* delete its linked Clip; screen footage isn't something a
  // Cursor edit should be able to remove as a side effect. Returns `timeline.cursorSegments`
  // unchanged (not a needlessly materialized copy) when nothing actually matched.
  function cursorSegmentsAfterClipsDeleted(deletedClips: TimelineClip[]): TimelineSegment<CursorEditSettings>[] {
    if (deletedClips.length === 0) return timeline.cursorSegments;
    const segments = effectiveSegments(timeline.cursorSegments, cursorDurationMs);
    const next = segments.filter(
      (s) => !deletedClips.some((c) => msEq(s.startMs, c.timelineStart) && msEq(s.endMs, c.timelineStart + (c.sourceEnd - c.sourceStart)))
    );
    return next.length === segments.length ? timeline.cursorSegments : next;
  }

  // Cut tool — splits whichever piece is on top at the click point (converting the click's
  // edited-ms position to a source position first) into two, in place. Snaps onto any other
  // track's existing cut boundary it's hovering near, so the two actually land on the same
  // ms. Outside cut mode, a pointerdown on empty track space instead starts a marquee-select
  // drag (see startMarquee) — the two are mutually exclusive by tool, so there's no conflict.
  function handleClipsTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (tool !== "cut") {
      startMarquee(e);
      return;
    }
    const track = clipsTrackRef.current;
    if (!track) return;
    const rawMs = pctToMs(e.clientX, track, durationMs);
    const snapMs = nearestPointMs(crossTrackBoundaryPoints("clips"), rawMs, cutSnapToleranceMs(track));
    cutClipsAndCursorAt(snapMs ?? rawMs);
    setCutGuide(null);
  }
  function handleClipsTrackPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (handleMarqueeMove(e)) return;
    if (tool !== "cut") return;
    const track = clipsTrackRef.current;
    if (!track) return;
    const ms = pctToMs(e.clientX, track, durationMs);
    const snapMs = nearestPointMs(crossTrackBoundaryPoints("clips"), ms, cutSnapToleranceMs(track));
    setCutGuide(snapMs !== null ? { track: "clips", ms: snapMs } : null);
  }
  function handleClipsTrackPointerLeave() {
    setCutGuide((g) => (g?.track === "clips" ? null : g));
  }
  function handleClipBodyPointerDown(e: React.PointerEvent<HTMLDivElement>, clip: TimelineClip) {
    if (tool === "cut") return; // let it bubble to the track's cut-mode split handler above
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      toggleSelect("clips", clip.id);
      return;
    }
    const track = clipsTrackRef.current;
    if (!track) return;
    if (selection.size > 1 && isSelected("clips", clip.id)) {
      startGroupDrag(e, "clips", clip.id);
      return;
    }
    const wasSoleSelected = selection.size === 1 && isSelected("clips", clip.id);
    if (!wasSoleSelected) selectOnly("clips", clip.id);
    dragDurationMsRef.current = durationMs;
    const pointerMs = pctToMs(e.clientX, track, durationMs);
    const clipDur = clip.sourceEnd - clip.sourceStart;
    // Exact boundary match, not "any overlap" — with independent cuts on both tracks (from
    // before this link existed, or made without going through cutClipsAndCursorAt), a
    // clip's span can overlap several unrelated Cursor segments at once; matching only an
    // exact [startMs, endMs) pair keeps a drag from sweeping all of them along with it (see
    // handleCursorSegmentPointerDown's own linkedClipIds for the mirrored fix).
    const linkedCursorSegIds = effectiveSegments(timeline.cursorSegments, cursorDurationMs)
      .filter((s) => msEq(s.startMs, clip.timelineStart) && msEq(s.endMs, clip.timelineStart + clipDur))
      .map((s) => s.id);
    clipDragRef.current = {
      id: clip.id, grabOffsetMs: pointerMs - clip.timelineStart,
      moved: false, downX: e.clientX, downY: e.clientY, wasSoleSelected, linkedCursorSegIds,
    };
    setDragCursor("grabbing");
    updateClips(bringClipToFront(clipsList(), clip.id));
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleClipBodyPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragMove(e);
      return;
    }
    const drag = clipDragRef.current;
    const track = clipsTrackRef.current;
    if (!drag || !track) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    const clips = clipsList();
    const clip = clips.find((c) => c.id === drag.id);
    if (!clip) return;
    const dur = clip.sourceEnd - clip.sourceStart;
    const scaleMs = dragDurationMsRef.current;
    const pointerMs = pctToMs(e.clientX, track, scaleMs);
    const rawStart = Math.max(0, pointerMs - drag.grabOffsetMs);
    const { start: newStart, touchId, guideMs } = resolveMoveSnap(
      "clips", clips, drag.id, rawStart, dur, cutSnapToleranceMs(track, scaleMs), scaleMs
    );
    setClipSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: "clips", id: drag.id, ms: guideMs } : null);
    const newClips = clips.map((c) => (c.id === drag.id ? { ...c, timelineStart: newStart } : c));
    // Carry along whatever Cursor segment(s) exactly matched this clip's span at drag-start
    // (see handleClipBodyPointerDown's linkedCursorSegIds) — they started exactly where the
    // clip did, so they land exactly where it lands, no offset math needed.
    const newCursorSegments =
      drag.linkedCursorSegIds.length === 0
        ? timeline.cursorSegments
        : effectiveSegments(timeline.cursorSegments, cursorDurationMs).map((s) => {
            if (!drag.linkedCursorSegIds.includes(s.id)) return s;
            const segDur = s.endMs - s.startMs;
            return { ...s, startMs: newStart, endMs: newStart + segDur };
          });
    onChange({ ...timeline, clips: newClips, cursorSegments: newCursorSegments });
  }
  function handleClipBodyPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragUp(e);
      return;
    }
    const drag = clipDragRef.current;
    if (drag && !drag.moved && drag.wasSoleSelected) clearSelection();
    clipDragRef.current = null;
    setDragCursor("");
    setClipSnapPair(null);
    setDragSnap(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Trim handles — grabbing an edge reveals (or hides) source footage on that side, out to
  // the raw recording's own start/end. The two ends move independently: trimming the left
  // edge keeps the *right* edge anchored (both in source and on the timeline — the piece
  // grows/shrinks from the left), trimming the right edge keeps the *left* edge anchored.
  // Trimming never checks what else is on the timeline — same free-overlap rule as moving
  // a piece, and grabbing an edge brings it to the front too, so an expanding piece always
  // wins over whatever it grows into.
  const MIN_CLIP_MS = 100;
  function handleClipEdgePointerDown(e: React.PointerEvent<HTMLDivElement>, clip: TimelineClip, edge: "left" | "right") {
    if (tool === "cut") return; // let it bubble to the track's cut-mode split handler
    e.stopPropagation();
    dragDurationMsRef.current = durationMs;
    const dur = clip.sourceEnd - clip.sourceStart;
    const boundaryMs = edge === "left" ? clip.timelineStart : clip.timelineStart + dur;
    const linkedCursorSegIds = effectiveSegments(timeline.cursorSegments, cursorDurationMs)
      .filter((s) => (edge === "left" ? msEq(s.startMs, boundaryMs) : msEq(s.endMs, boundaryMs)))
      .map((s) => s.id);
    clipTrimDragRef.current = { id: clip.id, edge, linkedCursorSegIds };
    setDragCursor("ew-resize");
    updateClips(bringClipToFront(clipsList(), clip.id));
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  const MIN_SEGMENT_MS = 20; // mirrors timelineSegments.ts's own (unexported) minimum
  function handleClipEdgePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = clipTrimDragRef.current;
    const track = clipsTrackRef.current;
    if (!drag || !track) return;
    const clips = clipsList();
    const clip = clips.find((c) => c.id === drag.id);
    if (!clip) return;
    const scaleMs = dragDurationMsRef.current;
    const rawMs = pctToMs(e.clientX, track, scaleMs);
    // The edge being dragged sits directly on the edited timeline (for the left edge it
    // *is* the new timelineStart; for the right edge, timelineStart is unchanged so the
    // pointer's edited-ms position equals the new right-edge position too) — so it can be
    // snapped against neighbor edges the same way a whole-piece move is.
    const { ms: pointerMs, touchId, guideMs } = resolveEdgeSnap(
      "clips", clips, drag.id, rawMs, cutSnapToleranceMs(track, scaleMs), scaleMs
    );
    setClipSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: "clips", id: drag.id, ms: guideMs } : null);
    // Whichever Cursor segment(s) shared this exact edge at drag-start (see
    // handleClipEdgePointerDown's linkedCursorSegIds) get that same edge pushed by the same
    // ms delta, so revealing/hiding footage on a Clips edge reveals/hides the matching
    // stretch of Cursor settings right along with it — and vice versa (see
    // handleCursorSegmentEdgePointerMove below). The delta is clamped against *both* sides'
    // own limits (MIN_CLIP_MS/source bounds here, MIN_SEGMENT_MS there) before being applied
    // to either — clamping them independently let the two edges disagree on how far they
    // could actually move, so one would silently lag behind the other and the link would
    // drift out of the exact-match sync everything else here depends on.
    const linkedSegs = effectiveSegments(timeline.cursorSegments, cursorDurationMs).filter((s) => drag.linkedCursorSegIds.includes(s.id));
    function applyLinkedCursorEdge(deltaMs: number) {
      if (linkedSegs.length === 0 || deltaMs === 0) return timeline.cursorSegments;
      const segments = effectiveSegments(timeline.cursorSegments, cursorDurationMs);
      return segments.map((s) => {
        if (!drag!.linkedCursorSegIds.includes(s.id)) return s;
        return drag!.edge === "left" ? { ...s, startMs: s.startMs + deltaMs } : { ...s, endMs: s.endMs + deltaMs };
      });
    }
    if (drag.edge === "left") {
      // The dragged edge *is* both the new sourceStart and the new timelineStart — they
      // move together so the piece's right edge stays put. Clamped so neither goes
      // negative and the piece keeps at least MIN_CLIP_MS of width.
      let delta = pointerMs - clip.timelineStart;
      delta = Math.max(delta, -clip.sourceStart, -clip.timelineStart);
      delta = Math.min(delta, clip.sourceEnd - clip.sourceStart - MIN_CLIP_MS);
      for (const s of linkedSegs) {
        delta = Math.max(delta, -s.startMs);
        delta = Math.min(delta, s.endMs - MIN_SEGMENT_MS - s.startMs);
      }
      if (delta === 0) return;
      const newClips = clips.map((c) =>
        c.id === drag.id ? { ...c, sourceStart: c.sourceStart + delta, timelineStart: c.timelineStart + delta } : c
      );
      onChange({ ...timeline, clips: newClips, cursorSegments: applyLinkedCursorEdge(delta) });
    } else {
      const desiredSourceEnd = clip.sourceStart + (pointerMs - clip.timelineStart);
      let clampedSourceEnd = clamp(desiredSourceEnd, clip.sourceStart + MIN_CLIP_MS, sourceDurationMs);
      let delta = clampedSourceEnd - clip.sourceEnd;
      for (const s of linkedSegs) {
        delta = Math.max(delta, s.startMs + MIN_SEGMENT_MS - s.endMs);
        delta = Math.min(delta, durationMs - s.endMs);
      }
      clampedSourceEnd = clip.sourceEnd + delta;
      if (delta === 0) return;
      const newClips = clips.map((c) => (c.id === drag.id ? { ...c, sourceEnd: clampedSourceEnd } : c));
      onChange({ ...timeline, clips: newClips, cursorSegments: applyLinkedCursorEdge(delta) });
    }
  }
  function handleClipEdgePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    clipTrimDragRef.current = null;
    setDragCursor("");
    setClipSnapPair(null);
    setDragSnap(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function renderClipsPieces() {
    return clipsList().map((clip) => {
      const dur = clip.sourceEnd - clip.sourceStart;
      if (dur <= 0) return null; // emptiedTrack's zero-width "whole track deleted" placeholder
      const touching = clipSnapPair !== null && (clipSnapPair.dragged === clip.id || clipSnapPair.touching === clip.id);
      const snapped = dragSnap?.track === "clips" && dragSnap.id === clip.id;
      const selected = isSelected("clips", clip.id);
      return (
        <div
          key={clip.id}
          className={`tl-clip-base${touching ? " tl-piece-touching" : ""}${snapped ? " tl-piece-snapped" : ""}${selected ? " selected" : ""}`}
          style={{ left: `${msToPct(clip.timelineStart, durationMs)}%`, width: `${msToPct(dur, durationMs)}%` }}
          onPointerDown={(e) => handleClipBodyPointerDown(e, clip)}
          onPointerMove={handleClipBodyPointerMove}
          onPointerUp={handleClipBodyPointerUp}
          onPointerEnter={() => setHoveredClipId(clip.id)}
          onPointerLeave={() => setHoveredClipId((id) => (id === clip.id ? null : id))}
          title={`${formatTime(clip.timelineStart)} – ${formatTime(clip.timelineStart + dur)} — click to select (Ctrl/Cmd+click to add), drag anywhere, even over another piece; drag an edge to trim`}
        >
          <div className="tl-piece-edge tl-piece-edge-left" onPointerDown={(e) => handleClipEdgePointerDown(e, clip, "left")} onPointerMove={handleClipEdgePointerMove} onPointerUp={handleClipEdgePointerUp} />
          <div className="tl-piece-edge tl-piece-edge-right" onPointerDown={(e) => handleClipEdgePointerDown(e, clip, "right")} onPointerMove={handleClipEdgePointerMove} onPointerUp={handleClipEdgePointerUp} />
          <span className="tl-piece-time">{formatTimeSecs(clip.timelineStart)} – {formatTimeSecs(clip.timelineStart + dur)}</span>
          <button
            type="button"
            className="tl-piece-delete"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onChange({
                ...timeline,
                clips: emptiedTrack(deleteClip(clipsList(), clip.id)),
                cursorSegments: cursorSegmentsAfterClipsDeleted([clip]),
              });
              discardFromSelection("clips", clip.id);
            }}
            title="Delete this part"
          >
            <Trash2 size={12} />
          </button>
        </div>
      );
    });
  }

  // Camera track — same free-move/overlap model as Clips (see TimelineClip's doc
  // comment), just backed by `timeline.cameraClips` and the camera-only source recording
  // instead of the screen one. A stretch nothing covers is a gap: the camera bubble is
  // simply hidden there in the preview, rather than played as anything.
  function updateCameraClips(next: TimelineClip[]) {
    onChange({ ...timeline, cameraClips: next });
  }
  function cameraClipsList(): TimelineClip[] {
    // Starts at 0, same as Clips now — see clipsList's own alignedLengthMs comment above,
    // and effectiveClips' own doc comment for why both tracks share one end point too.
    return effectiveClips(timeline.cameraClips, sourceDurationMs, 0, alignedLengthMs);
  }

  // Cursor/Layout — see renderSegmentTrack below for the shared rendering/interaction logic
  // these two feed into.
  function updateCursorSegments(next: TimelineSegment<CursorEditSettings>[]) {
    onChange({ ...timeline, cursorSegments: next });
  }
  function updateLayoutSegments(next: TimelineSegment<LayoutEditSettings>[]) {
    onChange({ ...timeline, layoutSegments: next });
  }
  function handleCameraClipBodyPointerDown(e: React.PointerEvent<HTMLDivElement>, clip: TimelineClip) {
    if (tool === "cut") return; // let it bubble to the track's cut-mode split handler below
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      toggleSelect("camera", clip.id);
      return;
    }
    const track = cameraTrackRef.current;
    if (!track) return;
    if (selection.size > 1 && isSelected("camera", clip.id)) {
      startGroupDrag(e, "camera", clip.id);
      return;
    }
    const wasSoleSelected = selection.size === 1 && isSelected("camera", clip.id);
    if (!wasSoleSelected) selectOnly("camera", clip.id);
    dragDurationMsRef.current = durationMs;
    const pointerMs = pctToMs(e.clientX, track, durationMs);
    cameraClipDragRef.current = {
      id: clip.id, grabOffsetMs: pointerMs - clip.timelineStart,
      moved: false, downX: e.clientX, downY: e.clientY, wasSoleSelected,
    };
    setDragCursor("grabbing");
    updateCameraClips(bringClipToFront(cameraClipsList(), clip.id));
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleCameraClipBodyPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragMove(e);
      return;
    }
    const drag = cameraClipDragRef.current;
    const track = cameraTrackRef.current;
    if (!drag || !track) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    const clips = cameraClipsList();
    const clip = clips.find((c) => c.id === drag.id);
    if (!clip) return;
    const dur = clip.sourceEnd - clip.sourceStart;
    const scaleMs = dragDurationMsRef.current;
    const pointerMs = pctToMs(e.clientX, track, scaleMs);
    const rawStart = Math.max(0, pointerMs - drag.grabOffsetMs);
    const { start: newStart, touchId, guideMs } = resolveMoveSnap(
      "camera", clips, drag.id, rawStart, dur, cutSnapToleranceMs(track, scaleMs), scaleMs
    );
    setCameraSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: "camera", id: drag.id, ms: guideMs } : null);
    updateCameraClips(clips.map((c) => (c.id === drag.id ? { ...c, timelineStart: newStart } : c)));
  }
  function handleCameraClipBodyPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragUp(e);
      return;
    }
    const drag = cameraClipDragRef.current;
    if (drag && !drag.moved && drag.wasSoleSelected) clearSelection();
    cameraClipDragRef.current = null;
    setDragCursor("");
    setCameraSnapPair(null);
    setDragSnap(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function handleCameraClipEdgePointerDown(e: React.PointerEvent<HTMLDivElement>, clip: TimelineClip, edge: "left" | "right") {
    if (tool === "cut") return; // let it bubble to the track's cut-mode split handler
    e.stopPropagation();
    dragDurationMsRef.current = durationMs;
    cameraClipTrimDragRef.current = { id: clip.id, edge };
    setDragCursor("ew-resize");
    updateCameraClips(bringClipToFront(cameraClipsList(), clip.id));
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleCameraClipEdgePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = cameraClipTrimDragRef.current;
    const track = cameraTrackRef.current;
    if (!drag || !track) return;
    const clips = cameraClipsList();
    const clip = clips.find((c) => c.id === drag.id);
    if (!clip) return;
    const scaleMs = dragDurationMsRef.current;
    const rawMs = pctToMs(e.clientX, track, scaleMs);
    const { ms: pointerMs, touchId, guideMs } = resolveEdgeSnap(
      "camera", clips, drag.id, rawMs, cutSnapToleranceMs(track, scaleMs), scaleMs
    );
    setCameraSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: "camera", id: drag.id, ms: guideMs } : null);
    if (drag.edge === "left") {
      let delta = pointerMs - clip.timelineStart;
      delta = Math.max(delta, -clip.sourceStart, -clip.timelineStart);
      delta = Math.min(delta, clip.sourceEnd - clip.sourceStart - MIN_CLIP_MS);
      if (delta === 0) return;
      updateCameraClips(
        clips.map((c) =>
          c.id === drag.id ? { ...c, sourceStart: c.sourceStart + delta, timelineStart: c.timelineStart + delta } : c
        )
      );
    } else {
      const desiredSourceEnd = clip.sourceStart + (pointerMs - clip.timelineStart);
      const clampedSourceEnd = clamp(desiredSourceEnd, clip.sourceStart + MIN_CLIP_MS, sourceDurationMs);
      updateCameraClips(clips.map((c) => (c.id === drag.id ? { ...c, sourceEnd: clampedSourceEnd } : c)));
    }
  }
  function handleCameraClipEdgePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    cameraClipTrimDragRef.current = null;
    setDragCursor("");
    setCameraSnapPair(null);
    setDragSnap(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Video/Audio tracks — the project's *added* media (see TimelineMediaClip), placed by
  // dragging a file onto the track from the Media panel or straight from the OS. Pieces
  // behave exactly like Clips/Camera ones (independent timelineStart, free overlap, edge
  // trimming, last-in-array-wins stacking), so everything below is one shared set
  // parameterized by which of the two tracks it's acting on, rather than a third and
  // fourth verbatim copy of the Clips handlers.
  function mediaClipsFor(track: MediaTrackKind): TimelineMediaClip[] {
    return track === "video" ? timeline.videoClips : timeline.audioClips;
  }
  function updateMediaClips(track: MediaTrackKind, next: TimelineMediaClip[]) {
    onChange(track === "video" ? { ...timeline, videoClips: next } : { ...timeline, audioClips: next });
  }
  function mediaItemFor(clip: TimelineMediaClip): EditProjectMediaItem | undefined {
    return mediaItems.find((m) => m.id === clip.mediaId);
  }
  /** Whether the Ext Video / Ext Audio row is shown at all. These two tracks are the only
   *  ones that can be genuinely inapplicable to a project — every other row edits something
   *  the recording always has — so a project with no added media of that kind doesn't carry
   *  an empty row for it. Pieces already placed keep their row open even if the pool item
   *  behind them is gone (a save written before it was removed): they'd otherwise be
   *  invisible and unreachable rather than visibly missing and deletable. */
  function hasMediaTrack(track: MediaTrackKind): boolean {
    return mediaItems.some((m) => m.kind === track) || mediaClipsFor(track).length > 0;
  }
  // How far a piece's right edge may be trimmed back out to — its own file's length, not
  // the recording's (`sourceDurationMs`, which is what the Clips/Camera tracks clamp
  // against). Falls back to the piece's current end for an item that's no longer in the
  // pool, so a missing file's piece can still be shortened but never grown into footage
  // nothing can vouch for.
  function mediaSourceEndCap(clip: TimelineMediaClip): number {
    return mediaItemFor(clip)?.durationMs ?? clip.sourceEnd;
  }
  /** Drops a whole media item onto a track as one new piece starting at `atMs` — the shared
   *  tail of both drop paths (an item dragged out of the Media panel, and a file dragged in
   *  from the OS once EditPage has added it to the pool). Appended last, so a piece dropped
   *  onto an occupied stretch lands on top of what's already there, same as any freshly
   *  grabbed piece. */
  function placeMediaClip(track: MediaTrackKind, item: EditProjectMediaItem, atMs: number) {
    if (item.durationMs <= 0) return;
    const clip: TimelineMediaClip = {
      id: newId(),
      mediaId: item.id,
      sourceStart: 0,
      sourceEnd: item.durationMs,
      timelineStart: Math.max(0, atMs),
    };
    updateMediaClips(track, [...mediaClipsFor(track), clip]);
    selectOnly(track, clip.id);
  }

  function handleMediaTrackPointerDown(e: React.PointerEvent<HTMLDivElement>, track: MediaTrackKind) {
    if (tool !== "cut") {
      startMarquee(e);
      return;
    }
    const trackEl = trackElFor(track);
    if (!trackEl) return;
    const rawMs = pctToMs(e.clientX, trackEl, durationMs);
    const snapMs = nearestPointMs(crossTrackBoundaryPoints(track), rawMs, cutSnapToleranceMs(trackEl));
    // Split at the *edited* position, not a source one: unlike Clips/Camera there's no
    // single source recording behind the track — each piece is its own file — so "cut here"
    // can only mean here on the timeline (see splitClipAtEditedMs).
    updateMediaClips(track, splitClipAtEditedMs(mediaClipsFor(track), snapMs ?? rawMs));
    setCutGuide(null);
  }
  function handleMediaTrackPointerMove(e: React.PointerEvent<HTMLDivElement>, track: MediaTrackKind) {
    if (handleMarqueeMove(e)) return;
    if (tool !== "cut") return;
    const trackEl = trackElFor(track);
    if (!trackEl) return;
    const ms = pctToMs(e.clientX, trackEl, durationMs);
    const snapMs = nearestPointMs(crossTrackBoundaryPoints(track), ms, cutSnapToleranceMs(trackEl));
    setCutGuide(snapMs !== null ? { track, ms: snapMs } : null);
  }
  function handleMediaTrackPointerLeave(track: MediaTrackKind) {
    setCutGuide((g) => (g?.track === track ? null : g));
  }
  function handleMediaClipBodyPointerDown(e: React.PointerEvent<HTMLDivElement>, track: MediaTrackKind, clip: TimelineMediaClip) {
    if (tool === "cut") return; // let it bubble to the track's cut-mode split handler above
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(track, clip.id);
      return;
    }
    const trackEl = trackElFor(track);
    if (!trackEl) return;
    if (selection.size > 1 && isSelected(track, clip.id)) {
      startGroupDrag(e, track, clip.id);
      return;
    }
    const wasSoleSelected = selection.size === 1 && isSelected(track, clip.id);
    if (!wasSoleSelected) selectOnly(track, clip.id);
    dragDurationMsRef.current = durationMs;
    const pointerMs = pctToMs(e.clientX, trackEl, durationMs);
    mediaClipDragRef.current = {
      track, id: clip.id, grabOffsetMs: pointerMs - clip.timelineStart,
      moved: false, downX: e.clientX, downY: e.clientY, wasSoleSelected,
    };
    setDragCursor("grabbing");
    updateMediaClips(track, bringClipToFront(mediaClipsFor(track), clip.id));
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleMediaClipBodyPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragMove(e);
      return;
    }
    const drag = mediaClipDragRef.current;
    if (!drag) return;
    const trackEl = trackElFor(drag.track);
    if (!trackEl) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    const clips = mediaClipsFor(drag.track);
    const clip = clips.find((c) => c.id === drag.id);
    if (!clip) return;
    const dur = clip.sourceEnd - clip.sourceStart;
    const scaleMs = dragDurationMsRef.current;
    const pointerMs = pctToMs(e.clientX, trackEl, scaleMs);
    const rawStart = Math.max(0, pointerMs - drag.grabOffsetMs);
    const { start: newStart, touchId, guideMs } = resolveMoveSnap(
      drag.track, clips, drag.id, rawStart, dur, cutSnapToleranceMs(trackEl, scaleMs), scaleMs
    );
    setMediaSnapPair(touchId ? { track: drag.track, dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: drag.track, id: drag.id, ms: guideMs } : null);
    updateMediaClips(drag.track, clips.map((c) => (c.id === drag.id ? { ...c, timelineStart: newStart } : c)));
  }
  function handleMediaClipBodyPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragUp(e);
      return;
    }
    const drag = mediaClipDragRef.current;
    if (drag && !drag.moved && drag.wasSoleSelected) clearSelection();
    mediaClipDragRef.current = null;
    setDragCursor("");
    setMediaSnapPair(null);
    setDragSnap(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function handleMediaClipEdgePointerDown(
    e: React.PointerEvent<HTMLDivElement>,
    track: MediaTrackKind,
    clip: TimelineMediaClip,
    edge: "left" | "right"
  ) {
    if (tool === "cut") return; // let it bubble to the track's cut-mode split handler
    e.stopPropagation();
    dragDurationMsRef.current = durationMs;
    mediaClipTrimDragRef.current = { track, id: clip.id, edge };
    setDragCursor("ew-resize");
    updateMediaClips(track, bringClipToFront(mediaClipsFor(track), clip.id));
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleMediaClipEdgePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = mediaClipTrimDragRef.current;
    if (!drag) return;
    const trackEl = trackElFor(drag.track);
    if (!trackEl) return;
    const clips = mediaClipsFor(drag.track);
    const clip = clips.find((c) => c.id === drag.id);
    if (!clip) return;
    const scaleMs = dragDurationMsRef.current;
    const rawMs = pctToMs(e.clientX, trackEl, scaleMs);
    const { ms: pointerMs, touchId, guideMs } = resolveEdgeSnap(
      drag.track, clips, drag.id, rawMs, cutSnapToleranceMs(trackEl, scaleMs), scaleMs
    );
    setMediaSnapPair(touchId ? { track: drag.track, dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: drag.track, id: drag.id, ms: guideMs } : null);
    if (drag.edge === "left") {
      // Identical to the Clips track's own left-edge trim: the dragged edge is both the new
      // sourceStart and the new timelineStart, so the piece's right edge stays put.
      let delta = pointerMs - clip.timelineStart;
      delta = Math.max(delta, -clip.sourceStart, -clip.timelineStart);
      delta = Math.min(delta, clip.sourceEnd - clip.sourceStart - MIN_CLIP_MS);
      if (delta === 0) return;
      updateMediaClips(
        drag.track,
        clips.map((c) =>
          c.id === drag.id ? { ...c, sourceStart: c.sourceStart + delta, timelineStart: c.timelineStart + delta } : c
        )
      );
    } else {
      const desiredSourceEnd = clip.sourceStart + (pointerMs - clip.timelineStart);
      const clampedSourceEnd = clamp(desiredSourceEnd, clip.sourceStart + MIN_CLIP_MS, mediaSourceEndCap(clip));
      updateMediaClips(drag.track, clips.map((c) => (c.id === drag.id ? { ...c, sourceEnd: clampedSourceEnd } : c)));
    }
  }
  function handleMediaClipEdgePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    mediaClipTrimDragRef.current = null;
    setDragCursor("");
    setMediaSnapPair(null);
    setDragSnap(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Dropping onto a media track. Two sources, both landing here: an item already in the
  // pool, dragged out of the Media panel (which puts its id on the drag under a
  // track-specific MIME type — see MEDIA_DRAG_MIME_PREFIX), and raw files dragged in from
  // Explorer/Finder, which have to join the pool first and so are handed back up to
  // EditPage instead. A drag carrying neither — stray text, or a pool item belonging to the
  // *other* track — is refused outright: no highlight, and the drop does nothing.
  function mediaDropAccepts(e: React.DragEvent<HTMLDivElement>, track: MediaTrackKind): boolean {
    const types = Array.from(e.dataTransfer.types);
    return types.includes(MEDIA_DRAG_MIME_PREFIX + track) || types.includes("Files");
  }
  function handleMediaTrackDragOver(e: React.DragEvent<HTMLDivElement>, track: MediaTrackKind) {
    if (!mediaDropAccepts(e, track)) return;
    // Both calls are load-bearing: preventDefault on dragover is what marks an element as a
    // drop target at all — without it the drop event never fires.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const trackEl = trackElFor(track);
    if (trackEl) setMediaDropTarget({ track, ms: pctToMs(e.clientX, trackEl, durationMs) });
  }
  function handleMediaTrackDragLeave(e: React.DragEvent<HTMLDivElement>, track: MediaTrackKind) {
    // dragleave also fires when the pointer crosses from the track onto a piece sitting on
    // it (the event bubbles up from the child) — relatedTarget is where the pointer actually
    // went, so a move that's still inside this track isn't a leave at all. Without the check
    // the drop highlight blinks off every time the pointer passes over an existing piece.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setMediaDropTarget((t) => (t?.track === track ? null : t));
  }
  function handleMediaTrackDrop(e: React.DragEvent<HTMLDivElement>, track: MediaTrackKind) {
    if (!mediaDropAccepts(e, track)) return;
    e.preventDefault();
    setMediaDropTarget(null);
    const trackEl = trackElFor(track);
    if (!trackEl) return;
    const atMs = pctToMs(e.clientX, trackEl, durationMs);
    const mediaId = e.dataTransfer.getData(MEDIA_DRAG_MIME_PREFIX + track);
    if (mediaId) {
      const item = mediaItems.find((m) => m.id === mediaId);
      if (item) placeMediaClip(track, item, atMs);
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    // getPathForFile, not the long-removed File.path — same as StorageFileBrowser's own
    // drop handler. EditPage filters out whatever isn't playable media and places each
    // remaining file on the track its own kind belongs to.
    onAddMediaFiles?.(files.map((f) => window.api.system.getPathForFile(f)), atMs);
  }

  function renderMediaTrack(track: MediaTrackKind, trackRef: React.RefObject<HTMLDivElement>) {
    const clips = mediaClipsFor(track);
    const dropping = mediaDropTarget?.track === track;
    return (
      <div
        className={`tl-track tl-track-${track}${tool === "cut" ? " tl-track-cut-mode" : ""}${dropping ? " tl-track-drop-active" : ""}`}
        ref={trackRef}
        onPointerDown={(e) => handleMediaTrackPointerDown(e, track)}
        onPointerMove={(e) => handleMediaTrackPointerMove(e, track)}
        onPointerUp={handleMarqueeUp}
        onPointerLeave={() => handleMediaTrackPointerLeave(track)}
        onDragOver={(e) => handleMediaTrackDragOver(e, track)}
        onDragLeave={(e) => handleMediaTrackDragLeave(e, track)}
        onDrop={(e) => handleMediaTrackDrop(e, track)}
        title={
          clips.length === 0
            ? `Drop ${track === "video" ? "a video" : "an audio"} file here — from the Media panel above, or straight from your file manager`
            : undefined
        }
      >
        {clips.map((clip) => {
          const dur = clip.sourceEnd - clip.sourceStart;
          if (dur <= 0) return null;
          const item = mediaItemFor(clip);
          const touching =
            mediaSnapPair?.track === track && (mediaSnapPair.dragged === clip.id || mediaSnapPair.touching === clip.id);
          const snapped = dragSnap?.track === track && dragSnap.id === clip.id;
          const selected = isSelected(track, clip.id);
          const label = item?.name ?? "Missing file";
          return (
            <div
              key={clip.id}
              className={`tl-media-piece tl-media-piece-${track}${touching ? " tl-piece-touching" : ""}${snapped ? " tl-piece-snapped" : ""}${selected ? " selected" : ""}${item ? "" : " tl-media-piece-missing"}`}
              style={{ left: `${msToPct(clip.timelineStart, durationMs)}%`, width: `${msToPct(dur, durationMs)}%` }}
              onPointerDown={(e) => handleMediaClipBodyPointerDown(e, track, clip)}
              onPointerMove={handleMediaClipBodyPointerMove}
              onPointerUp={handleMediaClipBodyPointerUp}
              title={`${label} · ${formatTime(clip.timelineStart)} – ${formatTime(clip.timelineStart + dur)}${item ? "" : " — this file is no longer in the project's media"} — click to select (Ctrl/Cmd+click to add), drag anywhere; drag an edge to trim`}
            >
              <div
                className="tl-piece-edge tl-piece-edge-left"
                onPointerDown={(e) => handleMediaClipEdgePointerDown(e, track, clip, "left")}
                onPointerMove={handleMediaClipEdgePointerMove}
                onPointerUp={handleMediaClipEdgePointerUp}
              />
              <div
                className="tl-piece-edge tl-piece-edge-right"
                onPointerDown={(e) => handleMediaClipEdgePointerDown(e, track, clip, "right")}
                onPointerMove={handleMediaClipEdgePointerMove}
                onPointerUp={handleMediaClipEdgePointerUp}
              />
              <span className="tl-media-piece-name">{label}</span>
              <button
                type="button"
                className="tl-piece-delete"
                onPointerDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => {
                  ev.stopPropagation();
                  updateMediaClips(track, deleteClip(clips, clip.id));
                  discardFromSelection(track, clip.id);
                }}
                title="Remove this piece from the timeline"
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
        {dropping && <div className="tl-media-drop-marker" style={{ left: `${msToPct(mediaDropTarget.ms, durationMs)}%` }} />}
        {renderCutGuide(track)}
      </div>
    );
  }

  /** One Effects row — Callout or Blur, identical but for which `kind` of block it holds
   *  and its color. Same interaction set as the Zoom row above it: click empty space to drop
   *  a block at that point, drag the body to move it, drag either edge to change its window,
   *  hover for the delete button, marquee-drag empty space to multi-select. */
  function renderEffectTrack(track: EffectTrackKind, trackRef: React.RefObject<HTMLDivElement>) {
    const label = track === "callout" ? "Callout" : "Blur";
    return (
      <div
        className={`tl-track tl-track-effect tl-track-${track}`}
        ref={trackRef}
        onClick={(e) => handleEffectTrackClick(e, track)}
        onPointerDown={startMarquee}
        onPointerMove={handleMarqueeMove}
        onPointerUp={handleMarqueeUp}
      >
        {effectsFor(track).map((fx) => {
          const selected = isSelected(track, fx.id);
          const touching =
            effectSnapPair !== null && effectSnapPair.track === track && (effectSnapPair.dragged === fx.id || effectSnapPair.touching === fx.id);
          const snapped = dragSnap?.track === track && dragSnap.id === fx.id;
          return (
            <div
              key={fx.id}
              className={`tl-effect-block tl-effect-block-${track}${selected ? " selected" : ""}${touching ? " tl-piece-touching" : ""}${snapped ? " tl-piece-snapped" : ""}`}
              style={{ left: `${msToPct(fx.startMs, durationMs)}%`, width: `${msToPct(fx.durationMs, durationMs)}%` }}
              onPointerDown={(e) => handleEffectBlockPointerDown(e, track, fx)}
              onPointerMove={handleEffectBlockPointerMove}
              onPointerUp={handleEffectBlockPointerUp}
              title={`${formatTime(fx.startMs)} – ${formatTime(fx.startMs + fx.durationMs)} · ${label}${fx.label ? ` "${fx.label}"` : ""} — click to select (Ctrl/Cmd+click to add), drag an edge to change duration`}
            >
              <div className="tl-piece-edge tl-piece-edge-left" onPointerDown={(e) => handleEffectEdgePointerDown(e, track, fx, "left")} onPointerMove={handleEffectEdgePointerMove} onPointerUp={handleEffectEdgePointerUp} />
              <div className="tl-piece-edge tl-piece-edge-right" onPointerDown={(e) => handleEffectEdgePointerDown(e, track, fx, "right")} onPointerMove={handleEffectEdgePointerMove} onPointerUp={handleEffectEdgePointerUp} />
              <span className="tl-effect-badge">{fx.label.trim() || label}</span>
              <button
                type="button"
                className="tl-piece-delete"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  removeEffectBlock(fx.id);
                }}
                title={`Remove this ${label.toLowerCase()}`}
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
        {renderCutGuide(track)}
      </div>
    );
  }

  function trackElFor(t: TrackKind): HTMLDivElement | null {
    switch (t) {
      case "clips": return clipsTrackRef.current;
      case "camera": return cameraTrackRef.current;
      case "zoom": return zoomTrackRef.current;
      case "callout": return calloutTrackRef.current;
      case "blur": return blurTrackRef.current;
      case "cursor": return cursorTrackRef.current;
      case "layout": return layoutTrackRef.current;
      case "video": return videoTrackRef.current;
      case "audio": return audioTrackRef.current;
    }
  }

  // Moving the whole multi-selection together — started (from handleClipBodyPointerDown/
  // handleCameraClipBodyPointerDown/handleZoomBlockPointerDown) when the piece grabbed is
  // already part of a selection of more than one. Snapshots every selected piece's own
  // startMs up front so the group can be shifted by one shared delta without drift, then
  // applies that same delta to all three tracks at once on every move.
  function startGroupDrag(e: React.PointerEvent<HTMLDivElement>, track: TrackKind, id: string) {
    const trackEl = trackElFor(track);
    if (!trackEl) return;
    dragDurationMsRef.current = durationMs;
    const pointerMs = pctToMs(e.clientX, trackEl, durationMs);
    const clips = clipsList();
    const cameraClips = cameraClipsList();
    const items: { track: TrackKind; id: string; startMs: number; maxStartMs?: number }[] = [];
    for (const key of selection) {
      const idx = key.indexOf(":");
      const t = key.slice(0, idx) as TrackKind;
      const pid = key.slice(idx + 1);
      if (t === "clips") {
        const c = clips.find((x) => x.id === pid);
        if (c) items.push({ track: t, id: pid, startMs: c.timelineStart });
      } else if (t === "camera") {
        const c = cameraClips.find((x) => x.id === pid);
        if (c) items.push({ track: t, id: pid, startMs: c.timelineStart });
      } else if (t === "zoom") {
        const z = timeline.zooms.find((x) => x.id === pid);
        if (z) items.push({ track: t, id: pid, startMs: z.startMs, maxStartMs: durationMs - z.durationMs });
      } else if (t === "callout" || t === "blur") {
        // Same end-of-timeline ceiling zoom blocks have — an effect block's window is
        // defined on the edited timeline, so it can't be dragged off the end of it.
        const fx = (timeline.effects ?? []).find((x) => x.id === pid);
        if (fx) items.push({ track: t, id: pid, startMs: fx.startMs, maxStartMs: durationMs - fx.durationMs });
      } else if (t === "video" || t === "audio") {
        const c = mediaClipsFor(t).find((x) => x.id === pid);
        if (c) items.push({ track: t, id: pid, startMs: c.timelineStart });
      }
      // Layout segments have no free position to drag — a group drag that includes one
      // alongside a draggable piece just leaves the segment where it is. Cursor segments
      // are the one exception (see below): not draggable *as a selection member* here, but
      // pulled along as synthetic items when a dragged Clips piece shares their stretch.
    }
    // Clips pieces in this drag carry along whatever Cursor segments exactly correspond to
    // their stretch of the timeline, same linkage a single-clip drag applies (see
    // handleClipBodyPointerDown's linkedCursorSegIds, including why it's an exact boundary
    // match and not "any overlap") — added as synthetic "cursor" items so they ride the
    // group's shared delta below, even though they weren't selected themselves.
    const draggedClipIds = new Set(items.filter((it) => it.track === "clips").map((it) => it.id));
    if (draggedClipIds.size > 0) {
      const segs = effectiveSegments(timeline.cursorSegments, cursorDurationMs);
      const linkedSegIds = new Set<string>();
      for (const c of clips) {
        if (!draggedClipIds.has(c.id)) continue;
        const dur = c.sourceEnd - c.sourceStart;
        for (const s of segs) {
          if (msEq(s.startMs, c.timelineStart) && msEq(s.endMs, c.timelineStart + dur) && !linkedSegIds.has(s.id)) {
            linkedSegIds.add(s.id);
            items.push({ track: "cursor", id: s.id, startMs: s.startMs });
          }
        }
      }
    }
    groupDragRef.current = { originMs: pointerMs, downX: e.clientX, downY: e.clientY, moved: false, clickedTrack: track, clickedId: id, items };
    setDragCursor("grabbing");
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleGroupDragMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = groupDragRef.current;
    if (!drag) return;
    const trackEl = trackElFor(drag.clickedTrack);
    if (!trackEl) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    const scaleMs = dragDurationMsRef.current;
    const pointerMs = pctToMs(e.clientX, trackEl, scaleMs);
    let delta = pointerMs - drag.originMs;
    // No item may go below 0 — clamp to the tightest (largest) lower bound across the group.
    delta = Math.max(delta, Math.max(...drag.items.map((it) => -it.startMs)));
    // Zoom items can't be dragged past the end of the timeline either (Clips/Camera pieces
    // have no such ceiling — see dragDurationMsRef's own doc comment).
    const maxCandidates = drag.items.filter((it) => it.maxStartMs !== undefined).map((it) => it.maxStartMs! - it.startMs);
    if (maxCandidates.length > 0) delta = Math.min(delta, Math.min(...maxCandidates));

    // One combined onChange, not three separate updateClips/updateCameraClips/updateZooms
    // calls — those would each read the same stale `timeline` prop within this single
    // synchronous handler, so only the last call's change would actually stick.
    const newClips = clipsList().map((c) => {
      const item = drag.items.find((it) => it.track === "clips" && it.id === c.id);
      return item ? { ...c, timelineStart: item.startMs + delta } : c;
    });
    const newCameraClips = cameraClipsList().map((c) => {
      const item = drag.items.find((it) => it.track === "camera" && it.id === c.id);
      return item ? { ...c, timelineStart: item.startMs + delta } : c;
    });
    const newZooms = timeline.zooms.map((z) => {
      const item = drag.items.find((it) => it.track === "zoom" && it.id === z.id);
      return item ? { ...z, startMs: item.startMs + delta } : z;
    });
    const newEffects = (timeline.effects ?? []).map((fx) => {
      const item = drag.items.find((it) => it.track === fx.kind && it.id === fx.id);
      return item ? { ...fx, startMs: item.startMs + delta } : fx;
    });
    const shiftMedia = (track: MediaTrackKind) =>
      mediaClipsFor(track).map((c) => {
        const item = drag.items.find((it) => it.track === track && it.id === c.id);
        return item ? { ...c, timelineStart: item.startMs + delta } : c;
      });
    const cursorItems = drag.items.filter((it) => it.track === "cursor");
    const newCursorSegments =
      cursorItems.length === 0
        ? timeline.cursorSegments
        : effectiveSegments(timeline.cursorSegments, cursorDurationMs).map((s) => {
            const item = cursorItems.find((it) => it.id === s.id);
            if (!item) return s;
            const segDur = s.endMs - s.startMs;
            const start = Math.max(0, item.startMs + delta);
            return { ...s, startMs: start, endMs: start + segDur };
          });
    onChange({
      ...timeline,
      clips: newClips,
      cameraClips: newCameraClips,
      zooms: newZooms,
      effects: newEffects,
      videoClips: shiftMedia("video"),
      audioClips: shiftMedia("audio"),
      cursorSegments: newCursorSegments,
    });
  }
  function handleGroupDragUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = groupDragRef.current;
    if (drag && !drag.moved) {
      // Clicked (didn't drag) a member of an existing multi-selection — collapse to just it.
      selectOnly(drag.clickedTrack, drag.clickedId);
    }
    groupDragRef.current = null;
    setDragCursor("");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Marquee (rubber-band) select — press on empty track space and drag to select every
  // Clips/Camera/Zoom piece the box touches, across all three tracks at once. Started from
  // whichever track's empty space the drag began on (each track's own pointerdown handler
  // calls this — see handleClipsTrackPointerDown et al); pointer capture on that same
  // element means the move/up events below keep arriving there even once the box has grown
  // to cover the other two tracks. A plain click (never clears DRAG_THRESHOLD_PX) is left to
  // whatever that track already does with an empty click instead (Clips/Camera: nothing but
  // clearing the selection; Zoom: also drops a new block — see handleZoomTrackClick).
  function startMarquee(e: React.PointerEvent<HTMLDivElement>) {
    marqueeDraggedRef.current = false;
    marqueeRef.current = {
      downX: e.clientX, downY: e.clientY, curX: e.clientX, curY: e.clientY,
      active: false, addMode: e.ctrlKey || e.metaKey || e.shiftKey,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  // Returns whether a marquee drag is in progress, so each track's own pointermove handler
  // can skip its normal logic (cut-guide preview, etc.) while one is.
  function handleMarqueeMove(e: React.PointerEvent<HTMLDivElement>): boolean {
    const m = marqueeRef.current;
    if (!m) return false;
    m.curX = e.clientX;
    m.curY = e.clientY;
    if (!m.active) {
      if (Math.hypot(e.clientX - m.downX, e.clientY - m.downY) < DRAG_THRESHOLD_PX) return true;
      m.active = true;
    }
    const container = tlInnerRef.current;
    if (container) {
      const rect = container.getBoundingClientRect();
      const x0 = Math.min(m.downX, m.curX) - rect.left;
      const x1 = Math.max(m.downX, m.curX) - rect.left;
      const y0 = Math.min(m.downY, m.curY) - rect.top;
      const y1 = Math.max(m.downY, m.curY) - rect.top;
      setMarqueeBox({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 });
    }
    return true;
  }
  function finalizeMarqueeHits(m: NonNullable<(typeof marqueeRef)["current"]>) {
    const x0 = Math.min(m.downX, m.curX);
    const x1 = Math.max(m.downX, m.curX);
    const y0 = Math.min(m.downY, m.curY);
    const y1 = Math.max(m.downY, m.curY);
    const hits = new Set<string>();
    function collect(trackKind: TrackKind, el: HTMLElement | null, items: { id: string; start: number; dur: number }[]) {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || y1 < rect.top || y0 > rect.bottom) return;
      const msAt = (clientX: number) => clamp01((clientX - rect.left) / rect.width) * durationMs;
      const msStart = msAt(x0);
      const msEnd = msAt(x1);
      for (const it of items) {
        if (it.start + it.dur > msStart && it.start < msEnd) hits.add(keyOf(trackKind, it.id));
      }
    }
    collect("clips", clipsTrackRef.current, clipsList().map((c) => ({ id: c.id, start: c.timelineStart, dur: c.sourceEnd - c.sourceStart })));
    collect("zoom", zoomTrackRef.current, timeline.zooms.map((z) => ({ id: z.id, start: z.startMs, dur: z.durationMs })));
    collect("callout", calloutTrackRef.current, effectsFor("callout").map((fx) => ({ id: fx.id, start: fx.startMs, dur: fx.durationMs })));
    collect("blur", blurTrackRef.current, effectsFor("blur").map((fx) => ({ id: fx.id, start: fx.startMs, dur: fx.durationMs })));
    collect("camera", cameraTrackRef.current, cameraClipsList().map((c) => ({ id: c.id, start: c.timelineStart, dur: c.sourceEnd - c.sourceStart })));
    collect("cursor", cursorTrackRef.current, effectiveSegments(timeline.cursorSegments, cursorDurationMs).map((s) => ({ id: s.id, start: s.startMs, dur: s.endMs - s.startMs })));
    collect("layout", layoutTrackRef.current, effectiveSegments(timeline.layoutSegments, footageDurationMs).map((s) => ({ id: s.id, start: s.startMs, dur: s.endMs - s.startMs })));
    collect("video", videoTrackRef.current, timeline.videoClips.map((c) => ({ id: c.id, start: c.timelineStart, dur: c.sourceEnd - c.sourceStart })));
    collect("audio", audioTrackRef.current, timeline.audioClips.map((c) => ({ id: c.id, start: c.timelineStart, dur: c.sourceEnd - c.sourceStart })));
    setSelection((prev) => (m.addMode ? new Set([...prev, ...hits]) : hits));
  }
  // Shared pointerup for all three tracks (see startMarquee) — a plain click on empty space
  // clears the selection (unless an additive modifier was held, in which case it's a no-op
  // rather than wiping out what Ctrl/Cmd-drag was about to add to); a real drag finalizes
  // the box into a selection.
  function handleMarqueeUp(e: React.PointerEvent<HTMLDivElement>) {
    const m = marqueeRef.current;
    if (!m) return;
    marqueeDraggedRef.current = m.active;
    marqueeRef.current = null;
    setMarqueeBox(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!m.active) {
      if (!m.addMode) clearSelection();
      return;
    }
    finalizeMarqueeHits(m);
  }

  // Removes every currently-selected piece in one shot — across all three tracks at once
  // if the selection spans more than one, via a single onChange (calling updateClips/
  // updateCameraClips/updateZooms separately here would each read the same stale `timeline`
  // prop within this one synchronous call, so only the last of the three would actually
  // stick — see the equivalent note on handleGroupDragMove).
  // Delete-key equivalent of the Cursor track's own hide-in-place hover-delete (see
  // hideCursorPiece below) — same "operate on the effective/materialized list" reasoning,
  // so hiding via a keyboard Delete works on an unedited track's single whole-timeline
  // piece too.
  function hideManyCursorPieces(rawSegments: TimelineSegment<CursorEditSettings>[], ids: Set<string>): TimelineSegment<CursorEditSettings>[] {
    let next = effectiveSegments(rawSegments, cursorDurationMs);
    for (const id of ids) next = hideCursorPiece(next, id);
    return next;
  }
  function deleteSelectedPieces() {
    const clipIds = new Set<string>();
    const cameraIds = new Set<string>();
    const zoomIds = new Set<string>();
    const effectIds = new Set<string>();
    const cursorIds = new Set<string>();
    const videoIds = new Set<string>();
    const audioIds = new Set<string>();
    for (const key of selection) {
      const idx = key.indexOf(":");
      const track = key.slice(0, idx);
      const id = key.slice(idx + 1);
      if (track === "clips") clipIds.add(id);
      else if (track === "camera") cameraIds.add(id);
      else if (track === "zoom") zoomIds.add(id);
      else if (track === "callout" || track === "blur") effectIds.add(id);
      else if (track === "cursor") cursorIds.add(id);
      else if (track === "video") videoIds.add(id);
      else if (track === "audio") audioIds.add(id);
      // Layout cuts have no delete of their own (see renderSegmentTrack's Layout call
      // below) — a selected one just gets deselected below, same as clicking away.
    }
    // Deleted Clips pieces take their linked Cursor segment(s) with them (see
    // cursorSegmentsAfterClipsDeleted) *before* any directly-selected Cursor pieces get
    // hidden below — both can apply in the same multi-delete.
    const cursorSegmentsAfterClips = cursorSegmentsAfterClipsDeleted(clipsList().filter((c) => clipIds.has(c.id)));
    onChange({
      ...timeline,
      clips: clipIds.size > 0 ? emptiedTrack(clipsList().filter((c) => !clipIds.has(c.id))) : timeline.clips,
      cameraClips: cameraIds.size > 0 ? emptiedTrack(cameraClipsList().filter((c) => !cameraIds.has(c.id))) : timeline.cameraClips,
      zooms: zoomIds.size > 0 ? timeline.zooms.filter((z) => !zoomIds.has(z.id)) : timeline.zooms,
      effects: effectIds.size > 0 ? (timeline.effects ?? []).filter((fx) => !effectIds.has(fx.id)) : timeline.effects,
      cursorSegments: cursorIds.size > 0 ? hideManyCursorPieces(cursorSegmentsAfterClips, cursorIds) : cursorSegmentsAfterClips,
      // Unlike Clips/Camera, an emptied media track needs no zero-width placeholder — an
      // empty array there genuinely means "nothing placed" rather than "unedited," so
      // there's no default piece for it to be mistaken for (see TimelineEditSettings).
      videoClips: videoIds.size > 0 ? timeline.videoClips.filter((c) => !videoIds.has(c.id)) : timeline.videoClips,
      audioClips: audioIds.size > 0 ? timeline.audioClips.filter((c) => !audioIds.has(c.id)) : timeline.audioClips,
    });
    clearSelection();
  }

  handleDeleteShortcutRef.current = () => {
    if (selection.size > 0) {
      deleteSelectedPieces();
      return true;
    }
    if (hoveredClipId !== null) {
      const clip = clipsList().find((c) => c.id === hoveredClipId);
      if (clip) {
        onChange({
          ...timeline,
          clips: emptiedTrack(deleteClip(clipsList(), clip.id)),
          cursorSegments: cursorSegmentsAfterClipsDeleted([clip]),
        });
        setHoveredClipId(null);
        return true;
      }
    }
    if (hoveredCameraClipId !== null) {
      const clip = cameraClipsList().find((c) => c.id === hoveredCameraClipId);
      if (clip) {
        updateCameraClips(emptiedTrack(deleteClip(cameraClipsList(), clip.id)));
        setHoveredCameraClipId(null);
        return true;
      }
    }
    return false;
  };

  // Ctrl/Cmd+A (see the keydown listener above) — every Clips/Camera/Zoom piece at once.
  function selectAll() {
    const all = new Set<string>();
    for (const c of clipsList()) all.add(keyOf("clips", c.id));
    for (const c of cameraClipsList()) all.add(keyOf("camera", c.id));
    for (const z of timeline.zooms) all.add(keyOf("zoom", z.id));
    for (const fx of timeline.effects ?? []) all.add(keyOf(fx.kind, fx.id));
    for (const s of effectiveSegments(timeline.cursorSegments, cursorDurationMs)) all.add(keyOf("cursor", s.id));
    for (const s of effectiveSegments(timeline.layoutSegments, footageDurationMs)) all.add(keyOf("layout", s.id));
    for (const c of timeline.videoClips) all.add(keyOf("video", c.id));
    for (const c of timeline.audioClips) all.add(keyOf("audio", c.id));
    setSelection(all);
  }
  handleSelectAllRef.current = selectAll;

  // Both resets clear the Ext Video/Ext Audio tracks' placed pieces too (they spread
  // DEFAULT_TIMELINE_EDIT_SETTINGS, whose media clip lists are empty) — but never the
  // project's media *pool* itself, which isn't a timeline edit: the files stay attached in
  // the Media panel, ready to be dropped back on.
  // Two separate reset buttons, next to the tool toggle — "default" and "original" are
  // meant to end up as two distinct baselines (TODO: wire each to its own actual settings
  // once that distinction is defined), but for now both just discard every cut, trim, zoom,
  // and camera edit and go back to the untouched recording. Both go through the same
  // `onChange` as every other edit, so each is a normal, undoable (Ctrl+Z) history step.
  function resetToDefault() {
    if (!window.confirm("Reset to default? This removes every cut, trim, zoom, callout, blur, camera edit, and anything placed on the Ext Video/Ext Audio tracks.")) return;
    clearSelection();
    // A single combined onChange, not a plain reset followed by a separate
    // updateZooms/autoZoomFromClicks call — those would each read the same stale
    // `timeline` prop within this one synchronous handler, so only the last would stick
    // (same hazard as handleGroupDragMove/deleteSelectedPieces). Auto-zoom is computed
    // against the *default* (uncut, aligned-with-Camera) clips, matching what a freshly
    // recorded project gets — see autoZoomOnLoad.
    const zooms = computeAutoZooms(
      effectiveClips(DEFAULT_TIMELINE_EDIT_SETTINGS.clips, sourceDurationMs, 0, alignedLengthMs, cameraStartOffsetMs ?? 0)
    );
    onChange({ ...DEFAULT_TIMELINE_EDIT_SETTINGS, zooms });
  }
  function resetToOriginal() {
    if (!window.confirm("Reset to original? This removes every cut, trim, zoom, callout, blur, camera edit, and anything placed on the Ext Video/Ext Audio tracks, and goes back to the original recording.")) return;
    clearSelection();
    onChange({ ...DEFAULT_TIMELINE_EDIT_SETTINGS });
  }

  function updateZooms(next: TimelineZoom[]) {
    onChange({ ...timeline, zooms: next });
  }
  /** Zoom blocks as plain [startMs, endMs] spans — what resolveSegmentMoveSnap/
   *  resolveSegmentEdgeSnap need to pull a dragged block flush against its neighbours. */
  function zoomSpans(): { id: string; startMs: number; endMs: number }[] {
    return timeline.zooms.map((z) => ({ id: z.id, startMs: z.startMs, endMs: z.startMs + z.durationMs }));
  }
  // Same hover-delete affordance Clips/Camera pieces have — the Zoom Effect panel also has
  // its own "Remove this zoom" button, but deleting straight from the block it's actually
  // on (no need to select a chip first) matches how every other track already works here.
  function removeZoom(id: string) {
    updateZooms(removeZoomLib(timeline.zooms, id));
    discardFromSelection("zoom", id);
  }

  function addZoomAt(anchorMs: number) {
    const startMs = Math.max(0, anchorMs - ZOOM_LEAD_MS);
    const blockDuration = Math.min(ZOOM_DEFAULT_DURATION_MS, Math.max(200, durationMs - startMs));
    const zoom: TimelineZoom = {
      id: newId(),
      startMs,
      durationMs: blockDuration,
      pct: ZOOM_DEFAULT_PCT,
      style: DEFAULT_NEW_ZOOM_STYLE,
      tilt: { ...DEFAULT_NEW_ZOOM_TILT },
    };
    updateZooms([...timeline.zooms, zoom]);
    selectOnly("zoom", zoom.id);
  }

  // "Magic" auto zoom — regenerates the whole Zoom track from where clicks actually
  // happened, instead of the user placing every block by hand. Clicks are recorded in raw
  // source ms (same clock cursor points/the video itself run on), so each one is first
  // mapped onto the *edited* timeline via sourceToEditedMs — a click inside a stretch since
  // cut out of the edit is simply dropped, since it isn't visible anywhere anymore. Clicks
  // close together *and in roughly the same spot* (a rapid double-click, or several quick
  // clicks across one UI element) are merged into one longer block spanning all of them
  // rather than a pile of overlapping short ones; an isolated click gets a single short
  // block, same length as a manually-placed one. Two clicks close together in time but far
  // apart on screen stay as two separate blocks with a real gap between them instead (see
  // SPATIAL_SPLIT_FRAC below) — holding one zoom across both would mean the crop has to
  // sweep that whole distance while still magnified, which reads as a fast, jarring pan;
  // splitting them lets the zoom ease back down through the gap while the cursor is
  // actually making that crossing, then back up once it's settled at the next spot.
  // Replaces the track outright (undo-able) rather than appending, so re-running it after
  // further cuts/trims regenerates cleanly instead of piling up stale blocks.
  const CLICK_CLUSTER_GAP_MS = 1200;
  const ZOOM_AUTO_TRAIL_MS = 700;
  // Fraction of the frame's own diagonal two clicks have to be apart before they're kept as
  // separate zoom blocks even when close in time (see the block comment above) — small
  // enough to still merge clicks within roughly the same button/menu, large enough to catch
  // an actual jump across the screen.
  const SPATIAL_SPLIT_FRAC = 0.18;
  // Minimum real gap enforced between two spatially-split blocks — short enough to barely
  // register as its own beat, long enough for computeActiveZoomPct's own ease in/out
  // (ZOOM_TRANSITION_MS) to actually read as a dip rather than a flicker.
  const ZOOM_VALLEY_GAP_MS = 260;
  // A clipped-apart block shorter than this on either side isn't worth it — the ease in/out
  // alone (ZOOM_TRANSITION_MS each edge) wouldn't leave any real hold in the middle, so
  // falls back to a plain merge instead (the old, always-merge behavior).
  const MIN_SPLIT_WINDOW_MS = ZOOM_TRANSITION_MS * 2;
  // The actual click-to-zoom-windows computation, factored out so both the magic-wand
  // button (against the *live* clips, below) and resetToDefault (against the *default*,
  // uncut clips) can share it without duplicating the clustering logic. Returns [] if
  // there's nothing to compute (no clicks loaded yet, none survive the clips they're
  // mapped against, or the timeline has no duration yet).
  function computeAutoZooms(clips: TimelineClip[]): TimelineZoom[] {
    if (!clicksSourceMs || clicksSourceMs.length === 0 || durationMs <= 0) return [];
    const items = clicksSourceMs
      .map((ms, i) => ({ editedMs: sourceToEditedMs(clips, ms), pos: clickPositions?.[i] ?? null }))
      .filter((it): it is { editedMs: number; pos: { x: number; y: number } | null } => it.editedMs !== null)
      .sort((a, b) => a.editedMs - b.editedMs);
    if (items.length === 0) return [];

    const diag = clickFrame ? Math.hypot(clickFrame.width, clickFrame.height) : null;
    // Unknown position (older recordings, or a click with no nearby cursor sample) always
    // falls back to time-only clustering — same as before spatial splitting existed.
    function farApart(a: { x: number; y: number } | null, b: { x: number; y: number } | null): boolean {
      if (!a || !b || !diag) return false;
      return Math.hypot(a.x - b.x, a.y - b.y) / diag > SPATIAL_SPLIT_FRAC;
    }

    // Pass 1 — group clicks by gap, same as before, except a click spatially far from the
    // cluster's most recent one starts a new cluster even if it's within the time gap.
    const clusters: (typeof items)[] = [];
    for (const it of items) {
      const cluster = clusters[clusters.length - 1];
      const prev = cluster?.[cluster.length - 1];
      if (cluster && prev && it.editedMs - prev.editedMs <= CLICK_CLUSTER_GAP_MS && !farApart(prev.pos, it.pos)) {
        cluster.push(it);
      } else {
        clusters.push([it]);
      }
    }

    // Pass 2 — turn each cluster into a [start, end) window (lead-in before the first
    // click, trailing hold after the last, stretched out to at least the same length a
    // manually-placed block gets), then reconcile it against the previous window: where the
    // two naturally overlap, either merge them into one continuous hold (same as before —
    // e.g. two clusters just over the gap threshold apart) or, if they were kept apart by
    // farApart above, clip them to a real minimum gap straddling the midpoint between the
    // two clusters' nearest clicks, falling back to a merge if clipping would leave either
    // side too short to read as a real ease in/out.
    const windows: { start: number; end: number }[] = [];
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      const start = Math.max(0, cluster[0].editedMs - ZOOM_LEAD_MS);
      let end = Math.min(durationMs, cluster[cluster.length - 1].editedMs + ZOOM_AUTO_TRAIL_MS);
      end = Math.min(durationMs, Math.max(end, start + ZOOM_DEFAULT_DURATION_MS));
      const prevWindow = windows[windows.length - 1];
      if (!prevWindow || start > prevWindow.end) {
        windows.push({ start, end });
        continue;
      }
      const prevCluster = clusters[i - 1];
      const midpoint = (prevCluster[prevCluster.length - 1].editedMs + cluster[0].editedMs) / 2;
      const clippedPrevEnd = midpoint - ZOOM_VALLEY_GAP_MS / 2;
      const clippedStart = midpoint + ZOOM_VALLEY_GAP_MS / 2;
      if (clippedPrevEnd - prevWindow.start >= MIN_SPLIT_WINDOW_MS && end - clippedStart >= MIN_SPLIT_WINDOW_MS) {
        prevWindow.end = clippedPrevEnd;
        windows.push({ start: clippedStart, end });
      } else {
        prevWindow.end = Math.max(prevWindow.end, end);
      }
    }

    return windows.map((w) => ({
      id: newId(),
      startMs: w.start,
      durationMs: w.end - w.start,
      pct: ZOOM_DEFAULT_PCT,
      style: DEFAULT_NEW_ZOOM_STYLE,
      tilt: { ...DEFAULT_NEW_ZOOM_TILT },
    }));
  }

  function autoZoomFromClicks() {
    const zooms = computeAutoZooms(
      effectiveClips(timeline.clips, sourceDurationMs, 0, alignedLengthMs, cameraStartOffsetMs ?? 0)
    );
    if (zooms.length === 0) return;
    updateZooms(zooms);
    clearSelection();
  }

  // Scrub — the ruler only. Clicking the Clips/Camera/Zoom tracks never moves the
  // playhead; it plays/selects/edits, and playback itself (in PreviewCompositor) is what
  // otherwise advances it.
  function scrubPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const el = rulerRef.current;
    if (!el) return;
    scrubbingRef.current = true;
    onSeek(pctToMs(e.clientX, el, durationMs));
    el.setPointerCapture(e.pointerId);
  }
  function scrubPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbingRef.current) return;
    const el = rulerRef.current;
    if (!el) return;
    onSeek(pctToMs(e.clientX, el, durationMs));
  }
  function scrubPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    scrubbingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Zoom track — a plain click on empty space drops a new block anchored a few hundred
  // ms before the click point; existing blocks handle their own drag-to-move. A press-and-
  // drag on empty space instead starts a marquee select (see startMarquee) — handleMarqueeUp
  // only lets this click-to-add-a-block logic fire when that drag never happened.
  function handleZoomTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget || marqueeDraggedRef.current) return;
    const track = zoomTrackRef.current;
    if (!track) return;
    addZoomAt(pctToMs(e.clientX, track, durationMs));
  }
  function handleZoomTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    startMarquee(e);
  }
  function handleZoomTrackPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    handleMarqueeMove(e);
  }
  function handleZoomBlockPointerDown(e: React.PointerEvent<HTMLDivElement>, zoom: TimelineZoom) {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      toggleSelect("zoom", zoom.id);
      return;
    }
    const track = zoomTrackRef.current;
    if (!track) return;
    if (selection.size > 1 && isSelected("zoom", zoom.id)) {
      startGroupDrag(e, "zoom", zoom.id);
      return;
    }
    const wasSoleSelected = selection.size === 1 && isSelected("zoom", zoom.id);
    if (!wasSoleSelected) selectOnly("zoom", zoom.id);
    const pointerMs = pctToMs(e.clientX, track, durationMs);
    zoomDragRef.current = {
      id: zoom.id, grabOffsetMs: pointerMs - zoom.startMs,
      moved: false, downX: e.clientX, downY: e.clientY, wasSoleSelected,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleZoomBlockPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragMove(e);
      return;
    }
    const drag = zoomDragRef.current;
    const track = zoomTrackRef.current;
    if (!drag || !track) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    const zoom = timeline.zooms.find((z) => z.id === drag.id);
    if (!zoom) return;
    const pointerMs = pctToMs(e.clientX, track, durationMs);
    const rawStart = clamp(pointerMs - drag.grabOffsetMs, 0, Math.max(0, durationMs - zoom.durationMs));
    // The same two-pull snap every other draggable track has had: flush against a neighbour
    // zoom block (both light up), or lined up with any *other* track's cut/piece/segment
    // boundary (the cross-track guide line, echoed onto each track that shares that ms).
    const { start: newStart, touchId, guideMs } = resolveSegmentMoveSnap(
      "zoom", zoomSpans(), drag.id, rawStart, zoom.durationMs, cutSnapToleranceMs(track), durationMs
    );
    setZoomSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: "zoom", id: drag.id, ms: guideMs } : null);
    updateZooms(timeline.zooms.map((z) => (z.id === zoom.id ? { ...z, startMs: clamp(newStart, 0, Math.max(0, durationMs - z.durationMs)) } : z)));
  }
  function handleZoomBlockPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragUp(e);
      return;
    }
    const drag = zoomDragRef.current;
    if (drag && !drag.moved && drag.wasSoleSelected) clearSelection();
    zoomDragRef.current = null;
    setZoomSnapPair(null);
    setDragSnap(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Duration trim handles — grabbing an edge stretches/shrinks the zoom block's window,
  // same idea as a Clips piece's edge trim (handleClipEdgePointerDown), just against the
  // edited timeline's own bounds instead of source footage: the left edge moves startMs
  // (keeping the right edge anchored), the right edge moves the end point (keeping
  // startMs anchored), both clamped to [0, durationMs] and to at least MIN_ZOOM_MS wide.
  const MIN_ZOOM_MS = 300;
  function handleZoomEdgePointerDown(e: React.PointerEvent<HTMLDivElement>, zoom: TimelineZoom, edge: "left" | "right") {
    // Trimming an edge never touches selection, same as Clips/Camera edge-trims.
    e.stopPropagation();
    zoomTrimDragRef.current = { id: zoom.id, edge };
    setDragCursor("ew-resize");
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleZoomEdgePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = zoomTrimDragRef.current;
    const track = zoomTrackRef.current;
    if (!drag || !track) return;
    const zoom = timeline.zooms.find((z) => z.id === drag.id);
    if (!zoom) return;
    const rawMs = pctToMs(e.clientX, track, durationMs);
    // Same neighbour/alignment snap the body drag above now gets — the trimmed edge sits
    // directly on the edited timeline, so it snaps against exactly the same two families.
    const { ms: pointerMs, touchId, guideMs } = resolveSegmentEdgeSnap(
      "zoom", zoomSpans(), drag.id, rawMs, cutSnapToleranceMs(track), durationMs
    );
    setZoomSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: "zoom", id: drag.id, ms: guideMs } : null);
    if (drag.edge === "left") {
      const endMs = zoom.startMs + zoom.durationMs;
      const newStart = clamp(pointerMs, 0, endMs - MIN_ZOOM_MS);
      updateZooms(timeline.zooms.map((z) => (z.id === zoom.id ? { ...z, startMs: newStart, durationMs: endMs - newStart } : z)));
    } else {
      const newEnd = clamp(pointerMs, zoom.startMs + MIN_ZOOM_MS, durationMs);
      updateZooms(timeline.zooms.map((z) => (z.id === zoom.id ? { ...z, durationMs: newEnd - zoom.startMs } : z)));
    }
  }
  function handleZoomEdgePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    zoomTrimDragRef.current = null;
    setZoomSnapPair(null);
    setDragSnap(null);
    setDragCursor("");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Effects tracks (Callout/Blur) — one parameterized set of handlers serving both rows,
  // the same way renderMediaTrack serves Ext Video/Ext Audio. Blocks behave exactly like
  // zoom blocks: click empty space to drop one, drag the body to move, drag either edge to
  // change its window, all with the same neighbour/cross-track snapping.
  function effectsFor(track: EffectTrackKind): TimelineEffect[] {
    return (timeline.effects ?? []).filter((fx) => fx.kind === track);
  }
  function effectSpans(track: EffectTrackKind): { id: string; startMs: number; endMs: number }[] {
    return effectsFor(track).map((fx) => ({ id: fx.id, startMs: fx.startMs, endMs: fx.startMs + fx.durationMs }));
  }
  function updateEffects(next: TimelineEffect[]) {
    onChange({ ...timeline, effects: next });
  }
  function patchEffect(id: string, patch: Partial<TimelineEffect>) {
    updateEffects((timeline.effects ?? []).map((fx) => (fx.id === id ? { ...fx, ...patch } : fx)));
  }
  function removeEffectBlock(id: string) {
    updateEffects(removeEffectLib(timeline.effects ?? [], id));
    discardFromSelection("callout", id);
    discardFromSelection("blur", id);
  }
  function addEffectAt(track: EffectTrackKind, anchorMs: number) {
    const startMs = Math.max(0, anchorMs);
    const blockDuration = Math.min(EFFECT_DEFAULT_DURATION_MS, Math.max(MIN_EFFECT_MS, durationMs - startMs));
    const effect = createEffect(track, undefined, startMs, blockDuration);
    updateEffects([...(timeline.effects ?? []), effect]);
    selectOnly(track, effect.id);
  }
  function handleEffectTrackClick(e: React.MouseEvent<HTMLDivElement>, track: EffectTrackKind) {
    if (e.target !== e.currentTarget || marqueeDraggedRef.current) return;
    const trackEl = effectTrackElFor(track);
    if (!trackEl) return;
    addEffectAt(track, pctToMs(e.clientX, trackEl, durationMs));
  }
  function effectTrackElFor(track: EffectTrackKind): HTMLDivElement | null {
    return track === "callout" ? calloutTrackRef.current : blurTrackRef.current;
  }
  function handleEffectBlockPointerDown(e: React.PointerEvent<HTMLDivElement>, track: EffectTrackKind, effect: TimelineEffect) {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(track, effect.id);
      return;
    }
    const trackEl = effectTrackElFor(track);
    if (!trackEl) return;
    if (selection.size > 1 && isSelected(track, effect.id)) {
      startGroupDrag(e, track, effect.id);
      return;
    }
    const wasSoleSelected = selection.size === 1 && isSelected(track, effect.id);
    if (!wasSoleSelected) selectOnly(track, effect.id);
    const pointerMs = pctToMs(e.clientX, trackEl, durationMs);
    effectDragRef.current = {
      track, id: effect.id, grabOffsetMs: pointerMs - effect.startMs,
      moved: false, downX: e.clientX, downY: e.clientY, wasSoleSelected,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleEffectBlockPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragMove(e);
      return;
    }
    const drag = effectDragRef.current;
    const trackEl = drag ? effectTrackElFor(drag.track) : null;
    if (!drag || !trackEl) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    const effect = (timeline.effects ?? []).find((fx) => fx.id === drag.id);
    if (!effect) return;
    const pointerMs = pctToMs(e.clientX, trackEl, durationMs);
    const rawStart = clamp(pointerMs - drag.grabOffsetMs, 0, Math.max(0, durationMs - effect.durationMs));
    const { start: newStart, touchId, guideMs } = resolveSegmentMoveSnap(
      drag.track, effectSpans(drag.track), drag.id, rawStart, effect.durationMs, cutSnapToleranceMs(trackEl), durationMs
    );
    setEffectSnapPair(touchId ? { track: drag.track, dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: drag.track, id: drag.id, ms: guideMs } : null);
    patchEffect(drag.id, { startMs: clamp(newStart, 0, Math.max(0, durationMs - effect.durationMs)) });
  }
  function handleEffectBlockPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragUp(e);
      return;
    }
    const drag = effectDragRef.current;
    if (drag && !drag.moved && drag.wasSoleSelected) clearSelection();
    effectDragRef.current = null;
    setEffectSnapPair(null);
    setDragSnap(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function handleEffectEdgePointerDown(e: React.PointerEvent<HTMLDivElement>, track: EffectTrackKind, effect: TimelineEffect, edge: "left" | "right") {
    e.stopPropagation();
    effectTrimDragRef.current = { track, id: effect.id, edge };
    setDragCursor("ew-resize");
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleEffectEdgePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = effectTrimDragRef.current;
    const trackEl = drag ? effectTrackElFor(drag.track) : null;
    if (!drag || !trackEl) return;
    const effect = (timeline.effects ?? []).find((fx) => fx.id === drag.id);
    if (!effect) return;
    const rawMs = pctToMs(e.clientX, trackEl, durationMs);
    const { ms: pointerMs, touchId, guideMs } = resolveSegmentEdgeSnap(
      drag.track, effectSpans(drag.track), drag.id, rawMs, cutSnapToleranceMs(trackEl), durationMs
    );
    setEffectSnapPair(touchId ? { track: drag.track, dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: drag.track, id: drag.id, ms: guideMs } : null);
    if (drag.edge === "left") {
      const endMs = effect.startMs + effect.durationMs;
      const newStart = clamp(pointerMs, 0, endMs - MIN_EFFECT_MS);
      patchEffect(effect.id, { startMs: newStart, durationMs: endMs - newStart });
    } else {
      const newEnd = clamp(pointerMs, effect.startMs + MIN_EFFECT_MS, durationMs);
      patchEffect(effect.id, { durationMs: newEnd - effect.startMs });
    }
  }
  function handleEffectEdgePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    effectTrimDragRef.current = null;
    setEffectSnapPair(null);
    setDragSnap(null);
    setDragCursor("");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Cut tool — same split behavior as the Clips track (see handleClipsTrackPointerDown),
  // just splitting whichever Camera piece is on top instead. Snaps onto any other track's
  // existing cut boundary it's hovering near so the two actually land on the same ms.
  function handleCameraTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (tool !== "cut") {
      startMarquee(e);
      return;
    }
    const track = cameraTrackRef.current;
    if (!track) return;
    const rawMs = pctToMs(e.clientX, track, durationMs);
    const snapMs = nearestPointMs(crossTrackBoundaryPoints("camera"), rawMs, cutSnapToleranceMs(track));
    const editedMs = snapMs ?? rawMs;
    const clips = cameraClipsList();
    const resolved = resolveClipAt(clips, editedMs);
    if (resolved) updateCameraClips(splitClipAtSource(clips, resolved.sourceMs));
    setCutGuide(null);
  }
  function handleCameraTrackPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (handleMarqueeMove(e)) return;
    if (tool !== "cut") return;
    const track = cameraTrackRef.current;
    if (!track) return;
    const ms = pctToMs(e.clientX, track, durationMs);
    const snapMs = nearestPointMs(crossTrackBoundaryPoints("camera"), ms, cutSnapToleranceMs(track));
    setCutGuide(snapMs !== null ? { track: "camera", ms: snapMs } : null);
  }
  function handleCameraTrackPointerLeave() {
    setCutGuide((g) => (g?.track === "camera" ? null : g));
  }

  function renderCameraPieces() {
    return cameraClipsList().map((clip) => {
      const dur = clip.sourceEnd - clip.sourceStart;
      if (dur <= 0) return null; // emptiedTrack's zero-width "whole track deleted" placeholder
      const touching = cameraSnapPair !== null && (cameraSnapPair.dragged === clip.id || cameraSnapPair.touching === clip.id);
      const snapped = dragSnap?.track === "camera" && dragSnap.id === clip.id;
      const selected = isSelected("camera", clip.id);
      // This piece's own resolved hidden state — its clipOverride's, if it has one and it
      // sets `hidden`, else the Camera tab's master toggle (cameraHidden). Dims it in place
      // so a cut hidden via its own per-cut override reads at a glance even while the
      // master toggle itself is off (and the whole track isn't already dimmed/locked by
      // cameraHidden below) — same treatment as a hidden Cursor cut.
      const clipHidden = timeline.cameraClipOverrides[clip.id]?.hidden ?? cameraHidden;
      return (
        <div
          key={clip.id}
          className={`tl-camera-fill${touching ? " tl-piece-touching" : ""}${snapped ? " tl-piece-snapped" : ""}${selected ? " selected" : ""}${clipHidden ? " tl-segment-disabled" : ""}`}
          style={{ left: `${msToPct(clip.timelineStart, durationMs)}%`, width: `${msToPct(dur, durationMs)}%` }}
          onPointerDown={(e) => handleCameraClipBodyPointerDown(e, clip)}
          onPointerMove={handleCameraClipBodyPointerMove}
          onPointerUp={handleCameraClipBodyPointerUp}
          onPointerEnter={() => setHoveredCameraClipId(clip.id)}
          onPointerLeave={() => setHoveredCameraClipId((id) => (id === clip.id ? null : id))}
          title={`${formatTime(clip.timelineStart)} – ${formatTime(clip.timelineStart + dur)}${clipHidden ? " · camera hidden" : ""} — click to select (Ctrl/Cmd+click to add), drag anywhere, even over another piece; drag an edge to trim`}
        >
          <div className="tl-piece-edge tl-piece-edge-left" onPointerDown={(e) => handleCameraClipEdgePointerDown(e, clip, "left")} onPointerMove={handleCameraClipEdgePointerMove} onPointerUp={handleCameraClipEdgePointerUp} />
          <div className="tl-piece-edge tl-piece-edge-right" onPointerDown={(e) => handleCameraClipEdgePointerDown(e, clip, "right")} onPointerMove={handleCameraClipEdgePointerMove} onPointerUp={handleCameraClipEdgePointerUp} />
          <span className="tl-piece-time">{formatTimeSecs(clip.timelineStart)} – {formatTimeSecs(clip.timelineStart + dur)}</span>
          <button
            type="button"
            className="tl-piece-delete"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              updateCameraClips(emptiedTrack(deleteClip(cameraClipsList(), clip.id)));
              discardFromSelection("camera", clip.id);
            }}
            title="Delete this part — camera hidden here in preview"
          >
            <Trash2 size={12} />
          </button>
        </div>
      );
    });
  }

  // The Cursor track's own hover-delete doesn't merge the cut away like Layout's (and every
  // Clips/Camera piece's) does — it *disables* it in place instead, same idea as a deleted
  // Camera piece leaving a real gap that reads as "camera hidden here": deleting a Cursor
  // cut hides the synthetic cursor for just that span. The cut itself stays a real,
  // selectable segment (its own panel can always turn hidden back off, on top of Undo),
  // which is only possible because — unlike a Camera gap — there's always a TimelineSegment
  // "there" to hold that state. Operates on the *effective* (already-materialized) list so
  // this also works on an unedited track's single whole-timeline piece, not just after a
  // real cut exists — hiding the whole recording shouldn't require cutting first.
  function hideCursorPiece(segments: TimelineSegment<CursorEditSettings>[], id: string): TimelineSegment<CursorEditSettings>[] {
    const seg = segments.find((s) => s.id === id);
    return setSegmentSettings(segments, id, { ...(seg?.settings ?? DEFAULT_CURSOR_EDIT_SETTINGS), hidden: true });
  }

  // Cursor is the one segment track that can be dragged, like a Clips/Camera piece — unlike
  // Layout, it stays linked to Clips (see cutClipsAndCursorAt for the cut-tool half of that
  // link): moving a Cursor segment carries along whatever Clips piece(s) shared its stretch
  // at drag-start, and moving a Clips piece carries the Cursor segments back (see
  // handleClipBodyPointerDown/Move's own linkedCursorSegIds). Unlike Layout/Cursor's normal
  // cut-only interaction, a dragged segment moves as a free piece — it can leave a gap
  // behind or land on top of another segment; resolveSegmentSettings already falls back to
  // the master Cursor settings wherever no segment covers a given ms, so a gap just reads as
  // "untouched," same as it does for a deleted Cursor cut today.
  function handleCursorSegmentPointerDown(e: React.PointerEvent<HTMLDivElement>, seg: { id: string; startMs: number; endMs: number }) {
    if (tool === "cut") return; // let it bubble to the track's cut-mode split handler above
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      toggleSelect("cursor", seg.id);
      return;
    }
    const track = cursorTrackRef.current;
    if (!track) return;
    const wasSoleSelected = selection.size === 1 && isSelected("cursor", seg.id);
    if (!wasSoleSelected) selectOnly("cursor", seg.id);
    dragDurationMsRef.current = durationMs;
    const pointerMs = pctToMs(e.clientX, track, durationMs);
    // Exact boundary match, not "any overlap" — see handleClipBodyPointerDown's own
    // linkedCursorSegIds for why: independently-cut pieces can overlap this segment's span
    // without actually corresponding to it, and dragging shouldn't sweep those along too.
    const linkedClipIds = clipsList()
      .filter((c) => msEq(c.timelineStart, seg.startMs) && msEq(c.timelineStart + (c.sourceEnd - c.sourceStart), seg.endMs))
      .map((c) => c.id);
    cursorSegDragRef.current = {
      id: seg.id, grabOffsetMs: pointerMs - seg.startMs,
      moved: false, downX: e.clientX, downY: e.clientY, wasSoleSelected, linkedClipIds,
    };
    setDragCursor("grabbing");
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleCursorSegmentPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = cursorSegDragRef.current;
    const track = cursorTrackRef.current;
    if (!drag || !track) return;
    if (!drag.moved) {
      if (Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
    }
    const segments = effectiveSegments(timeline.cursorSegments, cursorDurationMs);
    const seg = segments.find((s) => s.id === drag.id);
    if (!seg) return;
    const segDur = seg.endMs - seg.startMs;
    const scaleMs = dragDurationMsRef.current;
    const pointerMs = pctToMs(e.clientX, track, scaleMs);
    const rawStart = Math.max(0, pointerMs - drag.grabOffsetMs);
    const { start: newStart, touchId, guideMs } = resolveSegmentMoveSnap(
      "cursor", segments, drag.id, rawStart, segDur, cutSnapToleranceMs(track, scaleMs), scaleMs
    );
    setCursorSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: "cursor", id: drag.id, ms: guideMs } : null);
    const newCursorSegments = segments.map((s) => (s.id === drag.id ? { ...s, startMs: newStart, endMs: newStart + segDur } : s));
    const newClips =
      drag.linkedClipIds.length === 0
        ? timeline.clips
        : clipsList().map((c) => {
            return drag.linkedClipIds.includes(c.id) ? { ...c, timelineStart: newStart } : c;
          });
    onChange({ ...timeline, cursorSegments: newCursorSegments, clips: newClips });
  }
  function handleCursorSegmentPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = cursorSegDragRef.current;
    if (drag && !drag.moved && drag.wasSoleSelected) clearSelection();
    cursorSegDragRef.current = null;
    setDragCursor("");
    setCursorSnapPair(null);
    setDragSnap(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Cursor's own edge-trim handles — the other half of the Clips/Cursor reveal-and-hide
  // link (see handleClipEdgePointerDown's own comment): dragging a Cursor segment's edge
  // resizes it exactly like a Clips/Camera trim handle would, and whichever Clips piece(s)
  // had an edge exactly on that boundary at drag-start get trimmed the same amount right
  // along with it — same clamping (MIN_CLIP_MS, source bounds) as a direct Clips edge drag.
  function handleCursorSegmentEdgePointerDown(e: React.PointerEvent<HTMLDivElement>, seg: { id: string; startMs: number; endMs: number }, edge: "left" | "right") {
    if (tool === "cut") return; // let it bubble to the track's cut-mode split handler
    e.stopPropagation();
    dragDurationMsRef.current = durationMs;
    const boundaryMs = edge === "left" ? seg.startMs : seg.endMs;
    const linkedClipIds = clipsList()
      .filter((c) => (edge === "left" ? msEq(c.timelineStart, boundaryMs) : msEq(c.timelineStart + (c.sourceEnd - c.sourceStart), boundaryMs)))
      .map((c) => c.id);
    cursorSegTrimDragRef.current = { id: seg.id, edge, linkedClipIds };
    setDragCursor("ew-resize");
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleCursorSegmentEdgePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = cursorSegTrimDragRef.current;
    const track = cursorTrackRef.current;
    if (!drag || !track) return;
    const segments = effectiveSegments(timeline.cursorSegments, cursorDurationMs);
    const seg = segments.find((s) => s.id === drag.id);
    if (!seg) return;
    const scaleMs = dragDurationMsRef.current;
    const rawMs = pctToMs(e.clientX, track, scaleMs);
    // Same neighbor/alignment snap a Clips edge trim gets (see resolveEdgeSnap) — pulls this
    // edge flush against another Cursor segment's edge, lighting both up, or onto any other
    // track's boundary (the cross-track guide line).
    const { ms: pointerMs, touchId, guideMs } = resolveSegmentEdgeSnap(
      "cursor", segments, drag.id, rawMs, cutSnapToleranceMs(track, scaleMs), scaleMs
    );
    setCursorSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
    setDragSnap(guideMs !== null ? { track: "cursor", id: drag.id, ms: guideMs } : null);
    // Whichever Clips piece(s) shared this exact edge at drag-start (see
    // handleCursorSegmentEdgePointerDown's linkedClipIds) apply the *same* ms delta, clamped
    // against both this segment's own bounds (0/MIN_SEGMENT_MS) and each linked clip's own
    // (MIN_CLIP_MS, source bounds) before it's applied to either — see
    // handleClipEdgePointerMove's own comment for why clamping them separately would let the
    // two edges drift out of sync.
    const linkedClips = clipsList().filter((c) => drag.linkedClipIds.includes(c.id));
    function applyLinkedClips(deltaMs: number, edge: "left" | "right"): TimelineClip[] {
      if (linkedClips.length === 0 || deltaMs === 0) return timeline.clips;
      return clipsList().map((c) => {
        if (!drag!.linkedClipIds.includes(c.id)) return c;
        return edge === "left"
          ? { ...c, sourceStart: c.sourceStart + deltaMs, timelineStart: c.timelineStart + deltaMs }
          : { ...c, sourceEnd: c.sourceEnd + deltaMs };
      });
    }
    if (drag.edge === "left") {
      let delta = Math.min(Math.max(0, pointerMs), seg.endMs - MIN_SEGMENT_MS) - seg.startMs;
      for (const c of linkedClips) {
        delta = Math.max(delta, -c.sourceStart, -c.timelineStart);
        delta = Math.min(delta, c.sourceEnd - c.sourceStart - MIN_CLIP_MS);
      }
      if (delta === 0) return;
      const newSegments = segments.map((s) => (s.id === drag.id ? { ...s, startMs: s.startMs + delta } : s));
      onChange({ ...timeline, cursorSegments: newSegments, clips: applyLinkedClips(delta, "left") });
    } else {
      let delta = Math.max(Math.min(pointerMs, durationMs), seg.startMs + MIN_SEGMENT_MS) - seg.endMs;
      for (const c of linkedClips) {
        delta = Math.max(delta, c.sourceStart + MIN_CLIP_MS - c.sourceEnd);
        delta = Math.min(delta, sourceDurationMs - c.sourceEnd);
      }
      if (delta === 0) return;
      const newSegments = segments.map((s) => (s.id === drag.id ? { ...s, endMs: s.endMs + delta } : s));
      onChange({ ...timeline, cursorSegments: newSegments, clips: applyLinkedClips(delta, "right") });
    }
  }
  function handleCursorSegmentEdgePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    setCursorSnapPair(null);
    setDragSnap(null);
    cursorSegTrimDragRef.current = null;
    setDragCursor("");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Cursor/Layout tracks — unlike Clips/Camera/Zoom, these have no footage or free position
  // of their own: each is just a config-only TimelineSegment strip (shared/lib/
  // timelineSegments.ts) that tiles the whole timeline with no gaps. There's nothing to
  // drag or trim — clicking a segment selects it, the cut tool splits it. One generic
  // renderer, called once per track below (`T` is inferred per call from that track's own
  // settings type). `deleteOptions` gives Cursor its own hide-in-place hover-delete (see
  // hideCursorPiece above) — omitted entirely for Layout, which only supports cutting: a
  // Layout cut can't be removed once made, only split further or undone.
  function renderSegmentTrack<T>(
    trackKind: "cursor" | "layout",
    trackRef: React.RefObject<HTMLDivElement>,
    rawSegments: TimelineSegment<T>[],
    updateFn: (next: TimelineSegment<T>[]) => void,
    deleteOptions?: {
      onDelete: (segments: TimelineSegment<T>[], id: string) => TimelineSegment<T>[];
      title: string;
      /** True once a piece has actually been hidden/muted (not just "customized" some
       *  other way) — dims it on the Timeline, same at-a-glance "this stretch is disabled"
       *  read a deleted Camera piece's own gap already gives for free. */
      isDisabled: (settings: T | null) => boolean;
      disabledLabel: string;
    }
  ) {
    const segmentDurationMs = trackKind === "cursor" ? cursorDurationMs : footageDurationMs;
    const segments = effectiveSegments(rawSegments, segmentDurationMs);
    // Same cut-tool snapping the Clips/Camera tracks have always had, now that these three
    // take part in it too (see crossTrackBoundaryPoints): a cut lands exactly on a boundary
    // already sitting on another track when the pointer is hovering close enough to one.
    function handleTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
      if (tool !== "cut") {
        startMarquee(e);
        return;
      }
      const track = trackRef.current;
      if (!track) return;
      const rawMs = pctToMs(e.clientX, track, durationMs);
      const snapMs = nearestPointMs(crossTrackBoundaryPoints(trackKind), rawMs, cutSnapToleranceMs(track));
      const ms = snapMs ?? rawMs;
      // Cursor stays linked to Clips (see cutClipsAndCursorAt) — cutting one cuts the other
      // at the same point, so this goes through the shared combined-onChange helper instead
      // of just updateFn for Cursor specifically. Layout has no such link.
      if (trackKind === "cursor") cutClipsAndCursorAt(ms);
      else updateFn(splitSegmentAtPoint(rawSegments, ms, segmentDurationMs));
      setCutGuide(null);
    }
    function handleTrackPointerMove(e: React.PointerEvent<HTMLDivElement>) {
      if (handleMarqueeMove(e)) return;
      if (tool !== "cut") return;
      const track = trackRef.current;
      if (!track) return;
      const ms = pctToMs(e.clientX, track, durationMs);
      const snapMs = nearestPointMs(crossTrackBoundaryPoints(trackKind), ms, cutSnapToleranceMs(track));
      setCutGuide(snapMs !== null ? { track: trackKind, ms: snapMs } : null);
    }
    function handleTrackPointerLeave() {
      setCutGuide((g) => (g?.track === trackKind ? null : g));
    }
    function handleSegmentPointerDown(e: React.PointerEvent<HTMLDivElement>, segId: string) {
      if (tool === "cut") return; // let it bubble to the track's cut-mode split handler above
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        toggleSelect(trackKind, segId);
        return;
      }
      selectOnly(trackKind, segId);
    }
    return (
      <div
        className={`tl-track tl-track-${trackKind}${tool === "cut" ? " tl-track-cut-mode" : ""}`}
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handleTrackPointerMove}
        onPointerUp={handleMarqueeUp}
        onPointerLeave={handleTrackPointerLeave}
      >
        {segments.map((seg, i) => {
          const selected = isSelected(trackKind, seg.id);
          const disabled = deleteOptions?.isDisabled(seg.settings) ?? false;
          const statusSuffix = disabled ? ` · ${deleteOptions!.disabledLabel}` : seg.settings ? " · customized" : "";
          // Same "flush against a neighbor" / "aligned onto another track's boundary"
          // highlight Clips/Camera pieces get while dragging (see clipSnapPair/dragSnap) —
          // Cursor only, since Layout has no free position to drag.
          const touching = trackKind === "cursor" && cursorSnapPair !== null && (cursorSnapPair.dragged === seg.id || cursorSnapPair.touching === seg.id);
          const snapped = trackKind === "cursor" && dragSnap?.track === "cursor" && dragSnap.id === seg.id;
          return (
            <div
              key={seg.id}
              className={`tl-segment-piece${trackKind === "cursor" ? " tl-segment-draggable" : ""}${touching ? " tl-piece-touching" : ""}${snapped ? " tl-piece-snapped" : ""}${selected ? " selected" : ""}${disabled ? " tl-segment-disabled" : ""}`}
              style={{ left: `${msToPct(seg.startMs, durationMs)}%`, width: `${msToPct(seg.endMs - seg.startMs, durationMs)}%` }}
              onPointerDown={(e) => (trackKind === "cursor" ? handleCursorSegmentPointerDown(e, seg) : handleSegmentPointerDown(e, seg.id))}
              onPointerMove={trackKind === "cursor" ? handleCursorSegmentPointerMove : undefined}
              onPointerUp={trackKind === "cursor" ? handleCursorSegmentPointerUp : undefined}
              title={
                trackKind === "cursor"
                  ? `${formatTime(seg.startMs)} – ${formatTime(seg.endMs)}${statusSuffix} — click to select (Ctrl/Cmd+click to add), drag to move — carries any Clips footage sharing this stretch along with it`
                  : `${formatTime(seg.startMs)} – ${formatTime(seg.endMs)}${statusSuffix} — click to select (Ctrl/Cmd+click to add)`
              }
            >
              {i > 0 && <div className="tl-segment-boundary" />}
              {trackKind === "cursor" && (
                <>
                  <div className="tl-piece-edge tl-piece-edge-left" onPointerDown={(e) => handleCursorSegmentEdgePointerDown(e, seg, "left")} onPointerMove={handleCursorSegmentEdgePointerMove} onPointerUp={handleCursorSegmentEdgePointerUp} />
                  <div className="tl-piece-edge tl-piece-edge-right" onPointerDown={(e) => handleCursorSegmentEdgePointerDown(e, seg, "right")} onPointerMove={handleCursorSegmentEdgePointerMove} onPointerUp={handleCursorSegmentEdgePointerUp} />
                </>
              )}
              <span className="tl-piece-time">{formatTimeSecs(seg.startMs)} – {formatTimeSecs(seg.endMs)}</span>
              {deleteOptions && (
                <button
                  type="button"
                  className="tl-piece-delete"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    updateFn(deleteOptions.onDelete(segments, seg.id));
                  }}
                  title={deleteOptions.title}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          );
        })}
        {renderCutGuide(trackKind)}
      </div>
    );
  }

  // Every track's pieces reduced to plain [startMs, endMs] spans — the one shape three
  // separate things all need: the cut tool's cross-track snap targets
  // (crossTrackBoundaryPoints), a dragged piece's alignment targets (alignPointsForTrack),
  // and which tracks a guide line's ms is actually shared by (snapTargetTracks).
  // Placed here (not up by discardFromSelection/isSelected, where it first lived) because
  // matchableTrackItems reads clipsList/cameraClipsList, which in turn read alignedLengthMs
  // — a `const` declared further down (right above clipsList itself) — and a function
  // component's body runs top-to-bottom every render, so calling them from any earlier point
  // hits alignedLengthMs's temporal dead zone and throws. Every render function this needs
  // (clipsList, cameraClipsList, renderSegmentTrack's own effectiveSegments calls) is a
  // hoisted `function` declaration, so only the *consts* they close over need to already be
  // initialized — true anywhere after alignedLengthMs's own line, and definitely true here,
  // the last thing before the JSX return.
  const MATCHABLE_TRACKS: TrackKind[] = ["clips", "camera", "cursor", "layout", "zoom", "callout", "blur", "video", "audio"];
  function matchableTrackItems(track: TrackKind): { id: string; startMs: number; endMs: number }[] {
    switch (track) {
      case "clips":
        return clipsList().map((c) => ({ id: c.id, startMs: c.timelineStart, endMs: c.timelineStart + (c.sourceEnd - c.sourceStart) }));
      case "camera":
        return cameraClipsList().map((c) => ({ id: c.id, startMs: c.timelineStart, endMs: c.timelineStart + (c.sourceEnd - c.sourceStart) }));
      case "cursor":
        return effectiveSegments(timeline.cursorSegments, cursorDurationMs).map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs }));
      case "layout":
        return effectiveSegments(timeline.layoutSegments, footageDurationMs).map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs }));
      case "zoom":
        return timeline.zooms.map((z) => ({ id: z.id, startMs: z.startMs, endMs: z.startMs + z.durationMs }));
      case "callout":
      case "blur":
        return effectSpans(track);
      case "video":
      case "audio":
        return mediaClipsFor(track).map((c) => ({
          id: c.id,
          startMs: c.timelineStart,
          endMs: c.timelineStart + Math.max(0, c.sourceEnd - c.sourceStart),
        }));
      default:
        return [];
    }
  }

  /** Every cut boundary on every track *except* `exceptTrack` — what that track's cut tool
   *  snaps a new cut onto, so a cut made on any track can land exactly where one already
   *  sits on another. The timeline's own two outer ends are dropped: nothing can be cut
   *  there, so a guide pointing at them would only ever be a dead end. Called from the cut
   *  tool's pointer handlers (which run well after this render pass finishes), never during
   *  render itself — see the TDZ note above for why that distinction matters here. */
  function crossTrackBoundaryPoints(exceptTrack: TrackKind): number[] {
    const points: number[] = [];
    for (const track of MATCHABLE_TRACKS) {
      if (track === exceptTrack) continue;
      for (const it of matchableTrackItems(track)) points.push(it.startMs, it.endMs);
    }
    return Array.from(new Set(points)).filter((ms) => ms > 0 && ms < durationMs);
  }

  // The other half of the cut guide — which tracks already have a cut exactly where the
  // guide has snapped to. Deliberately identifies *tracks*, not pieces: a boundary is shared
  // by the piece on either side of it, so highlighting the pieces themselves lights up two
  // whole blocks for one cut and reads as "these two are involved" rather than "this line is
  // the cut you'd match." Drawing the line itself on each track that has it (renderCutGuide
  // below) says exactly that instead, and stays legible however narrow the pieces are.
  //
  // Two things draw this same cross-track alignment line, and never at once (they belong to
  // different tools): the cut tool hovering a track, and an Ext Video/Ext Audio piece being
  // dragged onto a boundary. `kind` is only for styling — a cut guide reads as "the cut
  // you're about to make," a drag snap as "you're lined up with this."
  const alignGuide: { track: TrackKind; ms: number; kind: "cut" | "drag" } | null = cutGuide
    ? { track: cutGuide.track, ms: cutGuide.ms, kind: "cut" }
    : dragSnap
      ? { track: dragSnap.track, ms: dragSnap.ms, kind: "drag" }
      : null;
  const snapTargetTracks = new Set<TrackKind>();
  if (alignGuide) {
    for (const track of MATCHABLE_TRACKS) {
      if (track === alignGuide.track) continue;
      for (const it of matchableTrackItems(track)) {
        if (it.startMs === alignGuide.ms || it.endMs === alignGuide.ms) {
          snapTargetTracks.add(track);
          break;
        }
      }
    }
  }

  /** The alignment guide on one track: the live line on whichever track owns it — the one
   *  the cut tool is hovering, or the one holding the piece being dragged — and a dimmer
   *  echo of it on every other track that already has a boundary at that same ms, lined up
   *  vertically with it. That echo is the whole point in both cases: it's what says *which*
   *  existing cuts, starts and ends the thing you're doing lines up with. */
  function renderCutGuide(track: TrackKind) {
    if (!alignGuide) return null;
    const isSource = alignGuide.track === track;
    if (!isSource && !snapTargetTracks.has(track)) return null;
    return (
      <div
        className={`tl-cut-guide${isSource ? "" : " tl-cut-guide-echo"}${alignGuide.kind === "drag" ? " tl-cut-guide-snap" : ""}`}
        style={{ left: `${msToPct(alignGuide.ms, durationMs)}%` }}
      />
    );
  }

  const tickStep = pickTickStepMs(durationMs);
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs; t += tickStep) ticks.push(t);

  return (
    <div className="tl-root">
    {/* An explicit width, with growing switched off, rather than a min-width: below 1 the
        point is for the timeline to end up *narrower* than its pane, and `flex: 1` would
        just grow it back to full width again. Timeline.css's own `min-width: 480px` still
        applies underneath as the absolute floor. At zoom 1 this is a plain 100%, i.e.
        exactly what `flex: 1` was already producing. */}
    <div className="tl-inner" ref={tlInnerRef} style={{ flex: "0 0 auto", width: `${viewZoom * 100}%` }}>
      <div className="tl-row tl-row-ruler">
        {/* Same header-column width as every other row, so the ruler still starts at the
            exact same x as the Clips/Zoom/Camera tracks — but this one holds the view-zoom
            slider instead of a row label, overflowing left into the tool-bar gutter (see
            .tl-view-zoom's negative margin) so the slider visually sits on top of both the
            tool bar and this label column, aligned with the timeline timestamp beside it.
            Double-click the slider snaps back to fit-to-width, since dragging a track this
            narrow back to exactly 1 is fiddly. */}
        <div className="tl-row-header tl-row-header-spacer">
          <div className="tl-view-zoom">
            <button
              type="button"
              className="tl-view-zoom-btn"
              onClick={() => stepViewZoom(-1)}
              disabled={viewZoom <= VIEW_ZOOM_MIN}
              title="Zoom the timeline out"
              aria-label="Zoom the timeline out"
            >
              <Minus size={9} />
            </button>
            <input
              type="range"
              className="tl-view-zoom-slider"
              min={VIEW_ZOOM_MIN}
              max={VIEW_ZOOM_MAX}
              step={VIEW_ZOOM_STEP}
              value={viewZoom}
              onChange={(e) => setViewZoom(Number(e.target.value))}
              onDoubleClick={() => setViewZoom(1)}
              aria-label="Timeline zoom"
              title={`Timeline zoom — ${viewZoom.toFixed(1)}× (double-click to fit)`}
            />
            <button
              type="button"
              className="tl-view-zoom-btn"
              onClick={() => stepViewZoom(1)}
              disabled={viewZoom >= VIEW_ZOOM_MAX}
              title="Zoom the timeline in"
              aria-label="Zoom the timeline in"
            >
              <Plus size={9} />
            </button>
          </div>
        </div>
        <div
          className="tl-ruler"
          ref={rulerRef}
          onPointerDown={scrubPointerDown}
          onPointerMove={scrubPointerMove}
          onPointerUp={scrubPointerUp}
        >
          {ticks.map((t) => (
            <div key={t} className="tl-tick" style={{ left: `${msToPct(t, durationMs)}%` }}>
              <span className="tl-tick-label">{formatTime(t)}</span>
            </div>
          ))}
          {/* The recording's end. Ticks land on whole tickStep multiples, so the last one is
              almost never the actual end — this pins the real total to the ruler's right
              edge, where it also can't be scrolled past at any view zoom. */}
          <span className="tl-ruler-end" title="Total length">{formatHms(durationMs)}</span>
        </div>
      </div>

      <div className="tl-tracks-block">
      <div className="tl-row">
        <div className={`tl-row-header tl-row-header-clips${activeTrack === "clips" ? " tl-row-focused" : ""}`}>Clips</div>
        <div
          className={`tl-track tl-track-clips${tool === "cut" ? " tl-track-cut-mode" : ""}`}
          ref={clipsTrackRef}
          onPointerDown={handleClipsTrackPointerDown}
          onPointerMove={handleClipsTrackPointerMove}
          onPointerUp={handleMarqueeUp}
          onPointerLeave={handleClipsTrackPointerLeave}
        >
          {renderClipsPieces()}
          {renderCutGuide("clips")}
        </div>
      </div>

      <div className="tl-row">
        <div className={`tl-row-header tl-row-header-zoom${activeTrack === "zoom" ? " tl-row-focused" : ""}`}>
          Zoom
          <button
            type="button"
            className="tl-zoom-magic-btn"
            onClick={
              clicksSourceMs?.length === 0 && window.api.system.platform === "darwin"
                ? () => window.api.capture.openInputMonitoringSettings()
                : autoZoomFromClicks
            }
            disabled={!clicksSourceMs || (clicksSourceMs.length === 0 && window.api.system.platform !== "darwin")}
            title={
              !clicksSourceMs
                ? "Auto zoom on clicks — loading click data…"
                : clicksSourceMs.length === 0
                  ? window.api.system.platform === "darwin"
                    ? "Auto zoom on clicks — no clicks recorded. Doculigent needs the Input Monitoring permission to detect clicks on macOS — click to open System Settings, then re-record."
                    : "Auto zoom on clicks — no clicks recorded for this project"
                  : "Auto zoom on clicks — replaces the Zoom track with blocks placed at every recorded click"
            }
          >
            <MagicWand size={10} weight="fill" />
          </button>
        </div>
        <div
          className="tl-track tl-track-zoom"
          ref={zoomTrackRef}
          onClick={handleZoomTrackClick}
          onPointerDown={handleZoomTrackPointerDown}
          onPointerMove={handleZoomTrackPointerMove}
          onPointerUp={handleMarqueeUp}
        >
          {timeline.zooms.map((zoom) => {
            const zoomSelected = isSelected("zoom", zoom.id);
            // Flush against a neighbouring zoom block, and/or lined up with a boundary on
            // another track — the same two highlights Clips/Camera/Cursor pieces get.
            const zoomTouching =
              zoomSnapPair !== null && (zoomSnapPair.dragged === zoom.id || zoomSnapPair.touching === zoom.id);
            const zoomSnapped = dragSnap?.track === "zoom" && dragSnap.id === zoom.id;
            return (
            <div
              key={zoom.id}
              className={`tl-zoom-block${zoomSelected ? " selected" : ""}${zoomTouching ? " tl-piece-touching" : ""}${zoomSnapped ? " tl-piece-snapped" : ""}`}
              style={{ left: `${msToPct(zoom.startMs, durationMs)}%`, width: `${msToPct(zoom.durationMs, durationMs)}%` }}
              onPointerDown={(e) => handleZoomBlockPointerDown(e, zoom)}
              onPointerMove={handleZoomBlockPointerMove}
              onPointerUp={handleZoomBlockPointerUp}
              title={`${formatTime(zoom.startMs)} – ${formatTime(zoom.startMs + zoom.durationMs)} · ${zoom.pct}% — click to select (Ctrl/Cmd+click to add), drag an edge to change duration`}
            >
              <div className="tl-piece-edge tl-piece-edge-left" onPointerDown={(e) => handleZoomEdgePointerDown(e, zoom, "left")} onPointerMove={handleZoomEdgePointerMove} onPointerUp={handleZoomEdgePointerUp} />
              <div className="tl-piece-edge tl-piece-edge-right" onPointerDown={(e) => handleZoomEdgePointerDown(e, zoom, "right")} onPointerMove={handleZoomEdgePointerMove} onPointerUp={handleZoomEdgePointerUp} />
              <span className="tl-zoom-pct-badge">{zoom.pct}%</span>
              <button
                type="button"
                className="tl-piece-delete"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  removeZoom(zoom.id);
                }}
                title="Remove this zoom"
              >
                <Trash2 size={12} />
              </button>
            </div>
            );
          })}
          {renderCutGuide("zoom")}
        </div>
      </div>

      {/* The Effects tab's two blocks get a row each — a callout/blur box is placed on the
          frame there, but *when* it shows is a timeline window like any other, so it's moved
          and trimmed here alongside the zooms. Same "only once there's something to show"
          rule the Ext Video/Ext Audio rows use (see hasMediaTrack below): an untouched
          project carries no empty Callout/Blur row, and each appears the moment its first
          block is added (from the panel's Add/quick-pick/draw, or a click on the row itself
          once it exists) and disappears again once the last one is removed. */}
      {effectsFor("callout").length > 0 && (
        <div className="tl-row">
          <div className={`tl-row-header tl-row-header-callout${activeTrack === "callout" ? " tl-row-focused" : ""}`}>Callout</div>
          {renderEffectTrack("callout", calloutTrackRef)}
        </div>
      )}

      {effectsFor("blur").length > 0 && (
        <div className="tl-row">
          <div className={`tl-row-header tl-row-header-blur${activeTrack === "blur" ? " tl-row-focused" : ""}`}>Blur</div>
          {renderEffectTrack("blur", blurTrackRef)}
        </div>
      )}

      <div className="tl-row">
        <div className={`tl-row-header tl-row-header-camera${cameraHidden ? " disabled" : ""}${activeTrack === "camera" ? " tl-row-focused" : ""}`}>Camera</div>
        <div
          className={`tl-track tl-track-camera${tool === "cut" ? " tl-track-cut-mode" : ""}${cameraHidden ? " disabled" : ""}`}
          ref={cameraTrackRef}
          onPointerDown={hasCamera ? handleCameraTrackPointerDown : undefined}
          onPointerMove={hasCamera ? handleCameraTrackPointerMove : undefined}
          onPointerUp={hasCamera ? handleMarqueeUp : undefined}
          onPointerLeave={hasCamera ? handleCameraTrackPointerLeave : undefined}
          title={
            !hasCamera
              ? "This recording has no separate camera track"
              : cameraHidden
                ? "Camera is hidden in the Camera tab — enable it there to edit this track"
                : undefined
          }
        >
          {!hasCamera ? null : (
            <>
              {renderCameraPieces()}
              {renderCutGuide("camera")}
            </>
          )}
        </div>
      </div>

      <div className="tl-row">
        <div className={`tl-row-header tl-row-header-cursor${activeTrack === "cursor" ? " tl-row-focused" : ""}`}>Cursor</div>
        {renderSegmentTrack("cursor", cursorTrackRef, timeline.cursorSegments, updateCursorSegments, {
          onDelete: hideCursorPiece,
          title: "Hide cursor for this stretch",
          isDisabled: (s) => !!s?.hidden,
          disabledLabel: "cursor hidden",
        })}
      </div>

      <div className="tl-row">
        <div className={`tl-row-header tl-row-header-layout${activeTrack === "layout" ? " tl-row-focused" : ""}`}>Layout</div>
        {renderSegmentTrack("layout", layoutTrackRef, timeline.layoutSegments, updateLayoutSegments)}
      </div>

      {/* Tool controls — pointer/cut toggle plus the two reset buttons — pinned to the
          bottom-left of the Clips/Zoom/Camera/Cursor/Layout block (see .tl-tool-toggle's
          absolute positioning in Timeline.css), stacked vertically with a tight 2px gap, so
          none of the track rows above change size or shift to make room for them. */}
      <div className="tl-tool-toggle" role="group" aria-label="Timeline tool">
        <button
          type="button"
          className={`tl-tool-btn${tool === "default" ? " active" : ""}`}
          aria-pressed={tool === "default"}
          onClick={() => onToolChange("default")}
          title="Default tool (V) — click the ruler to play, drag a Clips/Camera piece to reorder"
        >
          <MousePointer2 size={12} />
        </button>
        <button
          type="button"
          className={`tl-tool-btn${tool === "cut" ? " active" : ""}`}
          aria-pressed={tool === "cut"}
          onClick={() => onToolChange("cut")}
          title="Cut tool (C) — click the preview, or the Clips/Camera tracks, to split at that point"
        >
          <Scissors size={12} />
        </button>
        <button
          type="button"
          className="tl-tool-btn tl-reset-btn tl-reset-default-btn"
          onClick={resetToDefault}
          title="Reset to default — removes every cut, trim, zoom, camera edit, and anything placed on the Ext Video/Ext Audio tracks"
        >
          <RotateCcw size={12} />
        </button>
        <button
          type="button"
          className="tl-tool-btn tl-reset-btn tl-reset-original-btn"
          onClick={resetToOriginal}
          title="Reset to original — removes every cut, trim, zoom, camera edit, and anything placed on the Ext Video/Ext Audio tracks, and goes back to the original recording"
        >
          <RotateCcw size={12} />
        </button>
      </div>
      </div>

      {/* The two added-media tracks (see EditProject.media) — last, under the tracks that
          come from the recording itself, since these are what's been layered *on top* of it.
          "Ext" for external: unlike every row above, these play files from outside the
          recording. Each appears only once the project has media of its kind (see
          hasMediaTrack), so an untouched project's timeline looks exactly as it did before
          any of this existed. */}
      {hasMediaTrack("video") && (
        <div className="tl-row">
          <div className={`tl-row-header tl-row-header-video${activeTrack === "video" ? " tl-row-focused" : ""}`}>Ext Video</div>
          {renderMediaTrack("video", videoTrackRef)}
        </div>
      )}

      {hasMediaTrack("audio") && (
        <div className="tl-row">
          <div className={`tl-row-header tl-row-header-audio${activeTrack === "audio" ? " tl-row-focused" : ""}`}>Ext Audio</div>
          {renderMediaTrack("audio", audioTrackRef)}
        </div>
      )}

      <div
        className="tl-playhead"
        style={{ left: `calc(${TL_TRACK_START_PX}px + (100% - ${TL_TRACK_START_PX}px) * ${clamp01(currentMs / durationMs)})` }}
      />
      {marqueeBox && (
        <div
          className="tl-marquee"
          style={{ left: marqueeBox.left, top: marqueeBox.top, width: marqueeBox.width, height: marqueeBox.height }}
        />
      )}
    </div>
    </div>
  );
}
