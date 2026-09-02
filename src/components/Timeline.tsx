import { useEffect, useRef, useState } from "react";
import { MousePointer2, RotateCcw, RotateCw, Scissors, Trash2 } from "lucide-react";
import { MagicWand } from "@phosphor-icons/react";
import {
  DEFAULT_CURSOR_EDIT_SETTINGS,
  DEFAULT_SOUND_EDIT_SETTINGS,
  DEFAULT_TIMELINE_EDIT_SETTINGS,
  ZOOM_DEFAULT_DURATION_MS,
  ZOOM_DEFAULT_PCT,
  ZOOM_LEAD_MS,
  ZOOM_TRANSITION_MS,
  type CursorEditSettings,
  type CursorMetadata,
  type LayoutEditSettings,
  type SoundEditSettings,
  type TimelineClip,
  type TimelineEditSettings,
  type TimelineSegment,
  type TimelineZoom,
} from "@shared/types/models";
import { bringClipToFront, deleteClip, effectiveClips, resolveClipAt, sourceToEditedMs, splitClipAtSource } from "@shared/lib/timelineClips";
import { effectiveSegments, setSegmentSettings, splitSegmentAtPoint } from "@shared/lib/timelineSegments";
import {
  DEFAULT_NEW_ZOOM_STYLE,
  DEFAULT_NEW_ZOOM_TILT,
  removeZoom as removeZoomLib,
} from "@shared/lib/timelineZooms";
import { frameDimensions, toFrameCoords } from "@shared/lib/cursorFrame";
import { mediaUrl } from "@shared/constants/media";
import "./Timeline.css";

export type TimelineTool = "default" | "cut";

// Every piece across all six tracks — Clips/Camera pieces, Zoom blocks, and Cursor/Layout/
// Sound segments all share one selection set, keyed as `${track}:${id}` (see keyOf below)
// so a single Set<string> can hold a mixed multi-selection spanning tracks. Exported so
// EditPage's chip rail (focusRequest prop below) and activeTrack can reference it.
export type TrackKind = "clips" | "camera" | "zoom" | "cursor" | "layout" | "sound";

// Every .tl-row's header column (72px) plus the gap Timeline.css puts between it and the
// track (10px) — where the playhead's own left offset below has to start too, so it lines
// up with the ruler/Clips/Zoom/Camera tracks instead of the header column.
const TL_TRACK_START_PX = 82;

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

function pctToMs(clientX: number, el: HTMLElement, durationMs: number): number {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0) return 0;
  return clamp01((clientX - rect.left) / rect.width) * durationMs;
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
  cursorMetadataPath,
  autoZoomOnLoad,
  focusRequest,
  onFocusConsumed,
  activeTrack,
  onSoleSelect,
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
  // is close enough to snap onto a piece boundary already sitting on the *other* track — a
  // preview of "cut here and it'll line up with that one," shown before the click happens.
  const [cutGuide, setCutGuide] = useState<{ track: "clips" | "camera"; ms: number } | null>(null);
  // While dragging (moving or edge-trimming) a Clips/Camera piece, which other piece on
  // that same track it's currently snapped flush against (no gap, no overlap) — both the
  // dragged piece and its neighbor get a highlight so the touch is obvious mid-drag.
  const [clipSnapPair, setClipSnapPair] = useState<{ dragged: string; touching: string } | null>(null);
  const [cameraSnapPair, setCameraSnapPair] = useState<{ dragged: string; touching: string } | null>(null);

  const rulerRef = useRef<HTMLDivElement>(null);
  const clipsTrackRef = useRef<HTMLDivElement>(null);
  const zoomTrackRef = useRef<HTMLDivElement>(null);
  const cameraTrackRef = useRef<HTMLDivElement>(null);
  const cursorTrackRef = useRef<HTMLDivElement>(null);
  const layoutTrackRef = useRef<HTMLDivElement>(null);
  const soundTrackRef = useRef<HTMLDivElement>(null);
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
  } | null>(null);
  const clipTrimDragRef = useRef<{ id: string; edge: "left" | "right" } | null>(null);
  const cameraClipDragRef = useRef<{
    id: string; grabOffsetMs: number; moved: boolean; downX: number; downY: number; wasSoleSelected: boolean;
  } | null>(null);
  const cameraClipTrimDragRef = useRef<{ id: string; edge: "left" | "right" } | null>(null);
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
  // see effectiveClips' own doc comment. Timeline.tsx doesn't know the Camera track's own
  // real file duration (unlike PreviewCompositor, which does, via a loaded <video>
  // element), so this assumes it's at least sourceDurationMs - the offset; good enough for
  // where a freshly recorded project's pieces are drawn/dragged here, same approximation
  // already accepted for cameraClipsList's own end cap below.
  const alignedLengthMs = Math.max(0, sourceDurationMs - (cameraStartOffsetMs ?? 0));
  function clipsList(): TimelineClip[] {
    return effectiveClips(timeline.clips, sourceDurationMs, 0, alignedLengthMs, cameraStartOffsetMs ?? 0);
  }
  // A track's own pieces' edges (start and end) — what the *other* track's cut tool snaps
  // a new cut onto, so a Camera cut can land exactly where a Clips piece begins/ends (or
  // vice versa).
  function boundaryPointsOf(pieces: TimelineClip[]): number[] {
    const points: number[] = [];
    for (const c of pieces) {
      const dur = c.sourceEnd - c.sourceStart;
      points.push(c.timelineStart, c.timelineStart + dur);
    }
    return Array.from(new Set(points)).filter((ms) => ms >= 0 && ms <= durationMs);
  }
  function clipsBoundaryPoints(): number[] {
    return boundaryPointsOf(clipsList());
  }

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

  // Cut tool — splits whichever piece is on top at the click point (converting the click's
  // edited-ms position to a source position first) into two, in place. Snaps onto a Camera
  // piece boundary it's hovering near, so the two actually land on the same ms. Outside cut
  // mode, a pointerdown on empty track space instead starts a marquee-select drag (see
  // startMarquee) — the two are mutually exclusive by tool, so there's no conflict.
  function handleClipsTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (tool !== "cut") {
      startMarquee(e);
      return;
    }
    const track = clipsTrackRef.current;
    if (!track) return;
    const rawMs = pctToMs(e.clientX, track, durationMs);
    const snapMs = nearestPointMs(boundaryPointsOf(cameraClipsList()), rawMs, cutSnapToleranceMs(track));
    const editedMs = snapMs ?? rawMs;
    const clips = clipsList();
    const resolved = resolveClipAt(clips, editedMs);
    if (resolved) updateClips(splitClipAtSource(clips, resolved.sourceMs));
    setCutGuide(null);
  }
  function handleClipsTrackPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (handleMarqueeMove(e)) return;
    if (tool !== "cut") return;
    const track = clipsTrackRef.current;
    if (!track) return;
    const ms = pctToMs(e.clientX, track, durationMs);
    const snapMs = nearestPointMs(boundaryPointsOf(cameraClipsList()), ms, cutSnapToleranceMs(track));
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
    clipDragRef.current = {
      id: clip.id, grabOffsetMs: pointerMs - clip.timelineStart,
      moved: false, downX: e.clientX, downY: e.clientY, wasSoleSelected,
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
    const { start: newStart, touchId } = snapMoveToNeighbors(clips, drag.id, rawStart, dur, cutSnapToleranceMs(track, scaleMs));
    setClipSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
    updateClips(clips.map((c) => (c.id === drag.id ? { ...c, timelineStart: newStart } : c)));
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
    clipTrimDragRef.current = { id: clip.id, edge };
    setDragCursor("ew-resize");
    updateClips(bringClipToFront(clipsList(), clip.id));
    e.currentTarget.setPointerCapture(e.pointerId);
  }
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
    const { ms: pointerMs, touchId } = snapEdgeToNeighbors(clips, drag.id, rawMs, cutSnapToleranceMs(track, scaleMs));
    setClipSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
    if (drag.edge === "left") {
      // The dragged edge *is* both the new sourceStart and the new timelineStart — they
      // move together so the piece's right edge stays put. Clamped so neither goes
      // negative and the piece keeps at least MIN_CLIP_MS of width.
      let delta = pointerMs - clip.timelineStart;
      delta = Math.max(delta, -clip.sourceStart, -clip.timelineStart);
      delta = Math.min(delta, clip.sourceEnd - clip.sourceStart - MIN_CLIP_MS);
      if (delta === 0) return;
      updateClips(
        clips.map((c) =>
          c.id === drag.id ? { ...c, sourceStart: c.sourceStart + delta, timelineStart: c.timelineStart + delta } : c
        )
      );
    } else {
      const desiredSourceEnd = clip.sourceStart + (pointerMs - clip.timelineStart);
      const clampedSourceEnd = clamp(desiredSourceEnd, clip.sourceStart + MIN_CLIP_MS, sourceDurationMs);
      updateClips(clips.map((c) => (c.id === drag.id ? { ...c, sourceEnd: clampedSourceEnd } : c)));
    }
  }
  function handleClipEdgePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    clipTrimDragRef.current = null;
    setDragCursor("");
    setClipSnapPair(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function renderClipsPieces() {
    return clipsList().map((clip) => {
      const dur = clip.sourceEnd - clip.sourceStart;
      if (dur <= 0) return null; // emptiedTrack's zero-width "whole track deleted" placeholder
      const touching = clipSnapPair !== null && (clipSnapPair.dragged === clip.id || clipSnapPair.touching === clip.id);
      const selected = isSelected("clips", clip.id);
      return (
        <div
          key={clip.id}
          className={`tl-clip-base${touching ? " tl-piece-touching" : ""}${selected ? " selected" : ""}`}
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
              updateClips(emptiedTrack(deleteClip(clipsList(), clip.id)));
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

  // Cursor/Layout/Sound — see renderSegmentTrack below for the shared rendering/interaction
  // logic these three feed into.
  function updateCursorSegments(next: TimelineSegment<CursorEditSettings>[]) {
    onChange({ ...timeline, cursorSegments: next });
  }
  function updateLayoutSegments(next: TimelineSegment<LayoutEditSettings>[]) {
    onChange({ ...timeline, layoutSegments: next });
  }
  function updateSoundSegments(next: TimelineSegment<SoundEditSettings>[]) {
    onChange({ ...timeline, soundSegments: next });
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
    const { start: newStart, touchId } = snapMoveToNeighbors(clips, drag.id, rawStart, dur, cutSnapToleranceMs(track, scaleMs));
    setCameraSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
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
    const { ms: pointerMs, touchId } = snapEdgeToNeighbors(clips, drag.id, rawMs, cutSnapToleranceMs(track, scaleMs));
    setCameraSnapPair(touchId ? { dragged: drag.id, touching: touchId } : null);
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
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  function trackElFor(t: TrackKind): HTMLDivElement | null {
    switch (t) {
      case "clips": return clipsTrackRef.current;
      case "camera": return cameraTrackRef.current;
      case "zoom": return zoomTrackRef.current;
      case "cursor": return cursorTrackRef.current;
      case "layout": return layoutTrackRef.current;
      case "sound": return soundTrackRef.current;
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
      }
      // Cursor/Layout/Sound segments have no free position to drag — a group drag that
      // includes one alongside a draggable piece just leaves the segment where it is.
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
    onChange({ ...timeline, clips: newClips, cameraClips: newCameraClips, zooms: newZooms });
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
    collect("camera", cameraTrackRef.current, cameraClipsList().map((c) => ({ id: c.id, start: c.timelineStart, dur: c.sourceEnd - c.sourceStart })));
    collect("cursor", cursorTrackRef.current, effectiveSegments(timeline.cursorSegments, durationMs).map((s) => ({ id: s.id, start: s.startMs, dur: s.endMs - s.startMs })));
    collect("layout", layoutTrackRef.current, effectiveSegments(timeline.layoutSegments, durationMs).map((s) => ({ id: s.id, start: s.startMs, dur: s.endMs - s.startMs })));
    collect("sound", soundTrackRef.current, effectiveSegments(timeline.soundSegments, durationMs).map((s) => ({ id: s.id, start: s.startMs, dur: s.endMs - s.startMs })));
    setSelection((prev) => (m.addMode ? new Set([...prev, ...hits]) : hits));
  }
  // Shared pointerup for all three tracks (see startMarquee) — a plain click on empty space
  // clears the selection (unless an additive modifier was held, in which case it's a no-op
  // rather than wiping out what Ctrl/Cmd-drag was about to add to); a real drag finalizes
  // the box into a selection.
  function handleMarqueeUp(e: React.PointerEvent<HTMLDivElement>) {
    const m = marqueeRef.current;
    if (!m) return;
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
  // Delete-key equivalents of the Cursor/Sound tracks' own hide/mute-in-place hover-delete
  // (see hideCursorPiece/muteSoundPiece below) — same "operate on the effective/
  // materialized list" reasoning, so hiding/muting via a keyboard Delete works on an
  // unedited track's single whole-timeline piece too.
  function hideManyCursorPieces(rawSegments: TimelineSegment<CursorEditSettings>[], ids: Set<string>): TimelineSegment<CursorEditSettings>[] {
    let next = effectiveSegments(rawSegments, durationMs);
    for (const id of ids) next = hideCursorPiece(next, id);
    return next;
  }
  function muteManySoundPieces(rawSegments: TimelineSegment<SoundEditSettings>[], ids: Set<string>): TimelineSegment<SoundEditSettings>[] {
    let next = effectiveSegments(rawSegments, durationMs);
    for (const id of ids) next = muteSoundPiece(next, id);
    return next;
  }
  function deleteSelectedPieces() {
    const clipIds = new Set<string>();
    const cameraIds = new Set<string>();
    const zoomIds = new Set<string>();
    const cursorIds = new Set<string>();
    const soundIds = new Set<string>();
    for (const key of selection) {
      const idx = key.indexOf(":");
      const track = key.slice(0, idx);
      const id = key.slice(idx + 1);
      if (track === "clips") clipIds.add(id);
      else if (track === "camera") cameraIds.add(id);
      else if (track === "zoom") zoomIds.add(id);
      else if (track === "cursor") cursorIds.add(id);
      else if (track === "sound") soundIds.add(id);
      // Layout cuts have no delete of their own (see renderSegmentTrack's Layout call
      // below) — a selected one just gets deselected below, same as clicking away.
    }
    onChange({
      ...timeline,
      clips: clipIds.size > 0 ? emptiedTrack(clipsList().filter((c) => !clipIds.has(c.id))) : timeline.clips,
      cameraClips: cameraIds.size > 0 ? emptiedTrack(cameraClipsList().filter((c) => !cameraIds.has(c.id))) : timeline.cameraClips,
      zooms: zoomIds.size > 0 ? timeline.zooms.filter((z) => !zoomIds.has(z.id)) : timeline.zooms,
      cursorSegments: cursorIds.size > 0 ? hideManyCursorPieces(timeline.cursorSegments, cursorIds) : timeline.cursorSegments,
      soundSegments: soundIds.size > 0 ? muteManySoundPieces(timeline.soundSegments, soundIds) : timeline.soundSegments,
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
        updateClips(emptiedTrack(deleteClip(clipsList(), clip.id)));
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
    for (const s of effectiveSegments(timeline.cursorSegments, durationMs)) all.add(keyOf("cursor", s.id));
    for (const s of effectiveSegments(timeline.layoutSegments, durationMs)) all.add(keyOf("layout", s.id));
    for (const s of effectiveSegments(timeline.soundSegments, durationMs)) all.add(keyOf("sound", s.id));
    setSelection(all);
  }
  handleSelectAllRef.current = selectAll;

  // Two separate reset buttons, next to the tool toggle — "default" and "original" are
  // meant to end up as two distinct baselines (TODO: wire each to its own actual settings
  // once that distinction is defined), but for now both just discard every cut, trim, zoom,
  // and camera edit and go back to the untouched recording. Both go through the same
  // `onChange` as every other edit, so each is a normal, undoable (Ctrl+Z) history step.
  function resetToDefault() {
    if (!window.confirm("Reset to default? This removes every cut, trim, zoom, and camera edit.")) return;
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
    if (!window.confirm("Reset to original? This removes every cut, trim, zoom, and camera edit and goes back to the original recording.")) return;
    clearSelection();
    onChange({ ...DEFAULT_TIMELINE_EDIT_SETTINGS });
  }

  function updateZooms(next: TimelineZoom[]) {
    onChange({ ...timeline, zooms: next });
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
    if (e.target !== e.currentTarget) return;
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
    const newStart = clamp(pointerMs - drag.grabOffsetMs, 0, Math.max(0, durationMs - zoom.durationMs));
    updateZooms(timeline.zooms.map((z) => (z.id === zoom.id ? { ...z, startMs: newStart } : z)));
  }
  function handleZoomBlockPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (groupDragRef.current) {
      handleGroupDragUp(e);
      return;
    }
    const drag = zoomDragRef.current;
    if (drag && !drag.moved && drag.wasSoleSelected) clearSelection();
    zoomDragRef.current = null;
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
    const pointerMs = pctToMs(e.clientX, track, durationMs);
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
    setDragCursor("");
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }

  // Cut tool — same split behavior as the Clips track (see handleClipsTrackPointerDown),
  // just splitting whichever Camera piece is on top instead. Snaps onto a Clips piece
  // boundary it's hovering near so the two actually land on the same ms.
  function handleCameraTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (tool !== "cut") {
      startMarquee(e);
      return;
    }
    const track = cameraTrackRef.current;
    if (!track) return;
    const rawMs = pctToMs(e.clientX, track, durationMs);
    const snapMs = nearestPointMs(clipsBoundaryPoints(), rawMs, cutSnapToleranceMs(track));
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
    const snapMs = nearestPointMs(clipsBoundaryPoints(), ms, cutSnapToleranceMs(track));
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
      const selected = isSelected("camera", clip.id);
      // This piece's own resolved hidden state — its clipOverride's, if it has one and it
      // sets `hidden`, else the Camera tab's master toggle (cameraHidden). Dims it in place
      // so a cut hidden via its own per-cut override reads at a glance even while the
      // master toggle itself is off (and the whole track isn't already dimmed/locked by
      // cameraHidden below) — same treatment as a hidden Cursor/muted Sound cut.
      const clipHidden = timeline.cameraClipOverrides[clip.id]?.hidden ?? cameraHidden;
      return (
        <div
          key={clip.id}
          className={`tl-camera-fill${touching ? " tl-piece-touching" : ""}${selected ? " selected" : ""}${clipHidden ? " tl-segment-disabled" : ""}`}
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

  // Cursor/Sound tracks' own hover-delete doesn't merge the cut away like Layout's (and
  // every Clips/Camera piece's) does — it *disables* it in place instead, same idea as a
  // deleted Camera piece leaving a real gap that reads as "camera hidden here": deleting a
  // Cursor cut hides the synthetic cursor for just that span, deleting a Sound cut mutes
  // audio for just that span. The cut itself stays a real, selectable segment (its own
  // panel can always turn hidden/muted back off, on top of Undo), which is only possible
  // because — unlike a Camera gap — there's always a TimelineSegment "there" to hold that
  // state. Operates on the *effective* (already-materialized) list so this also works on
  // an unedited track's single whole-timeline piece, not just after a real cut exists —
  // hiding/muting the whole recording shouldn't require cutting first.
  function hideCursorPiece(segments: TimelineSegment<CursorEditSettings>[], id: string): TimelineSegment<CursorEditSettings>[] {
    const seg = segments.find((s) => s.id === id);
    return setSegmentSettings(segments, id, { ...(seg?.settings ?? DEFAULT_CURSOR_EDIT_SETTINGS), hidden: true });
  }
  function muteSoundPiece(segments: TimelineSegment<SoundEditSettings>[], id: string): TimelineSegment<SoundEditSettings>[] {
    const seg = segments.find((s) => s.id === id);
    return setSegmentSettings(segments, id, { ...(seg?.settings ?? DEFAULT_SOUND_EDIT_SETTINGS), muted: true });
  }

  // Cursor/Layout/Sound tracks — unlike Clips/Camera/Zoom, these have no footage or free
  // position of their own: each is just a config-only TimelineSegment strip (shared/lib/
  // timelineSegments.ts) that tiles the whole timeline with no gaps. There's nothing to
  // drag or trim — clicking a segment selects it, the cut tool splits it. One generic
  // renderer, called once per track below (`T` is inferred per call from that track's own
  // settings type). `deleteOptions` gives Cursor/Sound their own hide/mute-in-place hover-
  // delete (see hideCursorPiece/muteSoundPiece above) — omitted entirely for Layout, which
  // only supports cutting: a Layout cut can't be removed once made, only split further or
  // undone.
  function renderSegmentTrack<T>(
    trackKind: "cursor" | "layout" | "sound",
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
    const segments = effectiveSegments(rawSegments, durationMs);
    function handleTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
      if (tool !== "cut") {
        startMarquee(e);
        return;
      }
      const track = trackRef.current;
      if (!track) return;
      const ms = pctToMs(e.clientX, track, durationMs);
      updateFn(splitSegmentAtPoint(rawSegments, ms, durationMs));
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
        onPointerMove={handleMarqueeMove}
        onPointerUp={handleMarqueeUp}
      >
        {segments.map((seg, i) => {
          const selected = isSelected(trackKind, seg.id);
          const disabled = deleteOptions?.isDisabled(seg.settings) ?? false;
          const statusSuffix = disabled ? ` · ${deleteOptions!.disabledLabel}` : seg.settings ? " · customized" : "";
          return (
            <div
              key={seg.id}
              className={`tl-segment-piece${selected ? " selected" : ""}${disabled ? " tl-segment-disabled" : ""}`}
              style={{ left: `${msToPct(seg.startMs, durationMs)}%`, width: `${msToPct(seg.endMs - seg.startMs, durationMs)}%` }}
              onPointerDown={(e) => handleSegmentPointerDown(e, seg.id)}
              title={`${formatTime(seg.startMs)} – ${formatTime(seg.endMs)}${statusSuffix} — click to select (Ctrl/Cmd+click to add)`}
            >
              {i > 0 && <div className="tl-segment-boundary" />}
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
      </div>
    );
  }

  const tickStep = pickTickStepMs(durationMs);
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs; t += tickStep) ticks.push(t);

  return (
    <div className="tl-root">
    <div className="tl-inner" ref={tlInnerRef}>
      <div className="tl-row">
        <div className="tl-row-header tl-tool-toggle" role="group" aria-label="Timeline tool">
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
          <div className="tl-reset-group">
            <button
              type="button"
              className="tl-tool-btn tl-reset-btn tl-reset-default-btn"
              onClick={resetToDefault}
              title="Reset to default — removes every cut, trim, zoom, and camera edit"
            >
              <RotateCcw size={12} />
            </button>
            <button
              type="button"
              className="tl-tool-btn tl-reset-btn tl-reset-original-btn"
              onClick={resetToOriginal}
              title="Reset to original — removes every cut, trim, zoom, and camera edit and goes back to the original recording"
            >
              <RotateCw size={12} />
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
        </div>
      </div>

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
          {cutGuide?.track === "clips" && (
            <div className="tl-cut-guide" style={{ left: `${msToPct(cutGuide.ms, durationMs)}%` }} />
          )}
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
          {timeline.zooms.map((zoom) => (
            <div
              key={zoom.id}
              className={`tl-zoom-block${isSelected("zoom", zoom.id) ? " selected" : ""}`}
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
          ))}
        </div>
      </div>

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
              {cutGuide?.track === "camera" && (
                <div className="tl-cut-guide" style={{ left: `${msToPct(cutGuide.ms, durationMs)}%` }} />
              )}
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

      <div className="tl-row">
        <div className={`tl-row-header tl-row-header-sound${activeTrack === "sound" ? " tl-row-focused" : ""}`}>Sound</div>
        {renderSegmentTrack("sound", soundTrackRef, timeline.soundSegments, updateSoundSegments, {
          onDelete: muteSoundPiece,
          title: "Mute sound for this stretch",
          isDisabled: (s) => !!s?.muted,
          disabledLabel: "muted",
        })}
      </div>

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
