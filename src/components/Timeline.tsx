import { useEffect, useRef, useState } from "react";
import { MousePointer2, Scissors, Trash2, X } from "lucide-react";
import { MagicWand } from "@phosphor-icons/react";
import {
  ZOOM_DEFAULT_DURATION_MS,
  ZOOM_DEFAULT_PCT,
  ZOOM_LEAD_MS,
  ZOOM_PCT_PRESETS,
  type CursorMetadata,
  type TimelineClip,
  type TimelineEditSettings,
  type TimelineZoom,
  type TimelineZoomPct,
} from "@shared/types/models";
import { bringClipToFront, deleteClip, effectiveClips, resolveClipAt, sourceToEditedMs, splitClipAtSource } from "@shared/lib/timelineClips";
import { mediaUrl } from "@shared/constants/media";
import "./Timeline.css";

export type TimelineTool = "default" | "cut";

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
  /** Same recorded-cursor-track file PreviewCompositor reads for its live cursor overlay —
   *  fetched independently here just for its `clicks` timestamps, to drive the "auto zoom
   *  on clicks" magic button below. */
  cursorMetadataPath?: string | null;
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
  durationMs,
  sourceDurationMs,
  onSeek,
  tool,
  onToolChange,
  cameraHidden,
  cursorMetadataPath,
}: TimelineProps) {
  const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
  // Recorded click timestamps (raw source ms) for the "auto zoom on clicks" magic button —
  // null while unloaded/unavailable, distinct from an empty array (loaded, but the
  // recording genuinely has no clicks), so the button can tell "still loading" from
  // "nothing to work with" and word its title accordingly.
  const [clicksSourceMs, setClicksSourceMs] = useState<number[] | null>(null);
  useEffect(() => {
    setClicksSourceMs(null);
    if (!cursorMetadataPath) return;
    let cancelled = false;
    (async () => {
      try {
        const metadata: CursorMetadata = await (await fetch(mediaUrl(cursorMetadataPath))).json();
        if (!cancelled) setClicksSourceMs(metadata.clicks ?? []);
      } catch {
        // No cursor track for this recording — the magic button just stays disabled.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cursorMetadataPath]);
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
  // Whichever zoom block is currently selected (its pct/remove toolbar showing) — set as
  // that block's own ref below, purely so the outside-click effect can tell a click on the
  // block or its toolbar (still a descendant of this node) apart from a click anywhere else
  // in the app, which should close the toolbar.
  const selectedZoomBlockRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  const zoomDragRef = useRef<{ id: string; grabOffsetMs: number } | null>(null);
  const zoomTrimDragRef = useRef<{ id: string; edge: "left" | "right" } | null>(null);
  // Dragging a Clips piece by its body moves it (its own timelineStart) freely; grabbing
  // an edge instead trims that side, revealing (or hiding) source footage — see
  // handleClipEdgePointerMove. The Camera track's pieces work identically, just backed by
  // `timeline.cameraClips` instead of `timeline.clips` — see handleCameraClipBodyPointerDown
  // et al below.
  const clipDragRef = useRef<{ id: string; grabOffsetMs: number } | null>(null);
  const clipTrimDragRef = useRef<{ id: string; edge: "left" | "right" } | null>(null);
  const cameraClipDragRef = useRef<{ id: string; grabOffsetMs: number } | null>(null);
  const cameraClipTrimDragRef = useRef<{ id: string; edge: "left" | "right" } | null>(null);
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

  // Delete/Backspace — removes the selected Camera piece, if any. Only preventDefault when
  // something was actually selected, so Backspace still falls through to its usual
  // behavior otherwise.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
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

  // A selected zoom block's pct/remove toolbar closes on a click anywhere outside it —
  // the block itself already toggles selection off via its own onClick (see
  // handleZoomBlockClick), so this only needs to handle everywhere else: the rest of the
  // timeline, the preview canvas, other tabs, and so on.
  useEffect(() => {
    if (!selectedZoomId) return;
    function onOutside(e: MouseEvent) {
      if (selectedZoomBlockRef.current && !selectedZoomBlockRef.current.contains(e.target as Node)) {
        setSelectedZoomId(null);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [selectedZoomId]);

  if (durationMs <= 0) {
    return (
      <div className="tl-empty">
        <span className="tl-empty-icon">🎬</span>
        <span>Load a clip to start cutting and adding zooms.</span>
      </div>
    );
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
  function clipsList(): TimelineClip[] {
    return effectiveClips(timeline.clips, durationMs);
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
  // piece boundary it's hovering near, so the two actually land on the same ms.
  function handleClipsTrackPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (tool !== "cut") return;
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
    const track = clipsTrackRef.current;
    if (!track) return;
    dragDurationMsRef.current = durationMs;
    const pointerMs = pctToMs(e.clientX, track, durationMs);
    clipDragRef.current = { id: clip.id, grabOffsetMs: pointerMs - clip.timelineStart };
    setDragCursor("grabbing");
    updateClips(bringClipToFront(clipsList(), clip.id));
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleClipBodyPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = clipDragRef.current;
    const track = clipsTrackRef.current;
    if (!drag || !track) return;
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
      const touching = clipSnapPair !== null && (clipSnapPair.dragged === clip.id || clipSnapPair.touching === clip.id);
      return (
        <div
          key={clip.id}
          className={`tl-clip-base${touching ? " tl-piece-touching" : ""}`}
          style={{ left: `${msToPct(clip.timelineStart, durationMs)}%`, width: `${msToPct(dur, durationMs)}%` }}
          onPointerDown={(e) => handleClipBodyPointerDown(e, clip)}
          onPointerMove={handleClipBodyPointerMove}
          onPointerUp={handleClipBodyPointerUp}
          onPointerEnter={() => setHoveredClipId(clip.id)}
          onPointerLeave={() => setHoveredClipId((id) => (id === clip.id ? null : id))}
          title={`${formatTime(clip.timelineStart)} – ${formatTime(clip.timelineStart + dur)} — drag anywhere, even over another piece; drag an edge to trim`}
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
              updateClips(deleteClip(clipsList(), clip.id));
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
    return effectiveClips(timeline.cameraClips, sourceDurationMs);
  }
  function handleCameraClipBodyPointerDown(e: React.PointerEvent<HTMLDivElement>, clip: TimelineClip) {
    if (tool === "cut") return; // let it bubble to the track's cut-mode split handler below
    e.stopPropagation();
    const track = cameraTrackRef.current;
    if (!track) return;
    dragDurationMsRef.current = durationMs;
    const pointerMs = pctToMs(e.clientX, track, durationMs);
    cameraClipDragRef.current = { id: clip.id, grabOffsetMs: pointerMs - clip.timelineStart };
    setDragCursor("grabbing");
    updateCameraClips(bringClipToFront(cameraClipsList(), clip.id));
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleCameraClipBodyPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = cameraClipDragRef.current;
    const track = cameraTrackRef.current;
    if (!drag || !track) return;
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

  handleDeleteShortcutRef.current = () => {
    if (hoveredClipId !== null) {
      const clip = clipsList().find((c) => c.id === hoveredClipId);
      if (clip) {
        updateClips(deleteClip(clipsList(), clip.id));
        setHoveredClipId(null);
        return true;
      }
    }
    if (hoveredCameraClipId !== null) {
      const clip = cameraClipsList().find((c) => c.id === hoveredCameraClipId);
      if (clip) {
        updateCameraClips(deleteClip(cameraClipsList(), clip.id));
        setHoveredCameraClipId(null);
        return true;
      }
    }
    return false;
  };

  function updateZooms(next: TimelineZoom[]) {
    onChange({ ...timeline, zooms: next });
  }

  function removeZoom(id: string) {
    updateZooms(timeline.zooms.filter((z) => z.id !== id));
    setSelectedZoomId(null);
  }
  function setZoomPct(id: string, pct: TimelineZoomPct) {
    updateZooms(timeline.zooms.map((z) => (z.id === id ? { ...z, pct } : z)));
  }

  function addZoomAt(anchorMs: number) {
    const startMs = Math.max(0, anchorMs - ZOOM_LEAD_MS);
    const blockDuration = Math.min(ZOOM_DEFAULT_DURATION_MS, Math.max(200, durationMs - startMs));
    const zoom: TimelineZoom = { id: newId(), startMs, durationMs: blockDuration, pct: ZOOM_DEFAULT_PCT };
    updateZooms([...timeline.zooms, zoom]);
    setSelectedZoomId(zoom.id);
  }

  // "Magic" auto zoom — regenerates the whole Zoom track from where clicks actually
  // happened, instead of the user placing every block by hand. Clicks are recorded in raw
  // source ms (same clock cursor points/the video itself run on), so each one is first
  // mapped onto the *edited* timeline via sourceToEditedMs — a click inside a stretch since
  // cut out of the edit is simply dropped, since it isn't visible anywhere anymore. Clicks
  // close together (a rapid double-click, or several quick clicks across a UI) are merged
  // into one longer block spanning all of them rather than a pile of overlapping short
  // ones; an isolated click gets a single short block, same length as a manually-placed
  // one. Replaces the track outright (undo-able) rather than appending, so re-running it
  // after further cuts/trims regenerates cleanly instead of piling up stale blocks.
  const CLICK_CLUSTER_GAP_MS = 1200;
  const ZOOM_AUTO_TRAIL_MS = 700;
  function autoZoomFromClicks() {
    if (!clicksSourceMs || clicksSourceMs.length === 0 || durationMs <= 0) return;
    const clips = effectiveClips(timeline.clips, sourceDurationMs);
    const editedMs = clicksSourceMs
      .map((ms) => sourceToEditedMs(clips, ms))
      .filter((ms): ms is number => ms !== null)
      .sort((a, b) => a - b);
    if (editedMs.length === 0) return;

    // Pass 1 — group clicks themselves by gap.
    const clusters: number[][] = [];
    for (const ms of editedMs) {
      const last = clusters[clusters.length - 1];
      if (last && ms - last[last.length - 1] <= CLICK_CLUSTER_GAP_MS) last.push(ms);
      else clusters.push([ms]);
    }

    // Pass 2 — turn each cluster into a [start, end) window (lead-in before the first
    // click, trailing hold after the last, stretched out to at least the same length a
    // manually-placed block gets), then merge any windows that now overlap as a result of
    // that stretch — e.g. two clusters just over the gap threshold apart whose trailing
    // hold reaches into the next one's lead-in.
    const windows: { start: number; end: number }[] = [];
    for (const cluster of clusters) {
      const start = Math.max(0, cluster[0] - ZOOM_LEAD_MS);
      let end = Math.min(durationMs, cluster[cluster.length - 1] + ZOOM_AUTO_TRAIL_MS);
      end = Math.min(durationMs, Math.max(end, start + ZOOM_DEFAULT_DURATION_MS));
      const prev = windows[windows.length - 1];
      if (prev && start <= prev.end) prev.end = Math.max(prev.end, end);
      else windows.push({ start, end });
    }

    const zooms: TimelineZoom[] = windows.map((w) => ({
      id: newId(),
      startMs: w.start,
      durationMs: w.end - w.start,
      pct: ZOOM_DEFAULT_PCT,
    }));
    updateZooms(zooms);
    setSelectedZoomId(null);
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
  // ms before the click point; existing blocks handle their own drag-to-move.
  function handleZoomTrackClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    const track = zoomTrackRef.current;
    if (!track) return;
    addZoomAt(pctToMs(e.clientX, track, durationMs));
  }
  function handleZoomBlockPointerDown(e: React.PointerEvent<HTMLDivElement>, zoom: TimelineZoom) {
    // Only preps the drag here — selection is toggled by the click handler below. Setting
    // it here too would double-toggle: pointerdown selects, then the click that follows
    // immediately (even on a plain click, not just a drag) would flip it straight back off.
    e.stopPropagation();
    const track = zoomTrackRef.current;
    if (!track) return;
    const pointerMs = pctToMs(e.clientX, track, durationMs);
    zoomDragRef.current = { id: zoom.id, grabOffsetMs: pointerMs - zoom.startMs };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function handleZoomBlockPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = zoomDragRef.current;
    const track = zoomTrackRef.current;
    if (!drag || !track) return;
    const zoom = timeline.zooms.find((z) => z.id === drag.id);
    if (!zoom) return;
    const pointerMs = pctToMs(e.clientX, track, durationMs);
    const newStart = clamp(pointerMs - drag.grabOffsetMs, 0, Math.max(0, durationMs - zoom.durationMs));
    updateZooms(timeline.zooms.map((z) => (z.id === zoom.id ? { ...z, startMs: newStart } : z)));
  }
  function handleZoomBlockPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    zoomDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function handleZoomBlockClick(e: React.MouseEvent<HTMLDivElement>, zoomId: string) {
    e.stopPropagation();
    setSelectedZoomId((id) => (id === zoomId ? null : zoomId));
  }

  // Duration trim handles — grabbing an edge stretches/shrinks the zoom block's window,
  // same idea as a Clips piece's edge trim (handleClipEdgePointerDown), just against the
  // edited timeline's own bounds instead of source footage: the left edge moves startMs
  // (keeping the right edge anchored), the right edge moves the end point (keeping
  // startMs anchored), both clamped to [0, durationMs] and to at least MIN_ZOOM_MS wide.
  const MIN_ZOOM_MS = 300;
  function handleZoomEdgePointerDown(e: React.PointerEvent<HTMLDivElement>, zoom: TimelineZoom, edge: "left" | "right") {
    // Selection is left to the click that follows (see handleZoomBlockPointerDown's note
    // above) — setting it here too would double-toggle it straight back off.
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
    if (tool !== "cut") return;
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
      const touching = cameraSnapPair !== null && (cameraSnapPair.dragged === clip.id || cameraSnapPair.touching === clip.id);
      return (
        <div
          key={clip.id}
          className={`tl-camera-fill${touching ? " tl-piece-touching" : ""}`}
          style={{ left: `${msToPct(clip.timelineStart, durationMs)}%`, width: `${msToPct(dur, durationMs)}%` }}
          onPointerDown={(e) => handleCameraClipBodyPointerDown(e, clip)}
          onPointerMove={handleCameraClipBodyPointerMove}
          onPointerUp={handleCameraClipBodyPointerUp}
          onPointerEnter={() => setHoveredCameraClipId(clip.id)}
          onPointerLeave={() => setHoveredCameraClipId((id) => (id === clip.id ? null : id))}
          title={`${formatTime(clip.timelineStart)} – ${formatTime(clip.timelineStart + dur)} — drag anywhere, even over another piece; drag an edge to trim`}
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
              updateCameraClips(deleteClip(cameraClipsList(), clip.id));
            }}
            title="Delete this part — camera hidden here in preview"
          >
            <Trash2 size={12} />
          </button>
        </div>
      );
    });
  }

  const tickStep = pickTickStepMs(durationMs);
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs; t += tickStep) ticks.push(t);

  return (
    <div className="tl-root">
    <div className="tl-inner">
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
        <div className="tl-row-header tl-row-header-clips">Clips</div>
        <div
          className={`tl-track tl-track-clips${tool === "cut" ? " tl-track-cut-mode" : ""}`}
          ref={clipsTrackRef}
          onPointerDown={handleClipsTrackPointerDown}
          onPointerMove={handleClipsTrackPointerMove}
          onPointerLeave={handleClipsTrackPointerLeave}
        >
          {renderClipsPieces()}
          {cutGuide?.track === "clips" && (
            <div className="tl-cut-guide" style={{ left: `${msToPct(cutGuide.ms, durationMs)}%` }} />
          )}
        </div>
      </div>

      <div className="tl-row">
        <div className="tl-row-header tl-row-header-zoom">
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
        <div className="tl-track tl-track-zoom" ref={zoomTrackRef} onClick={handleZoomTrackClick}>
          {timeline.zooms.map((zoom) => (
            <div
              key={zoom.id}
              ref={selectedZoomId === zoom.id ? selectedZoomBlockRef : undefined}
              className={`tl-zoom-block${selectedZoomId === zoom.id ? " selected" : ""}`}
              style={{ left: `${msToPct(zoom.startMs, durationMs)}%`, width: `${msToPct(zoom.durationMs, durationMs)}%` }}
              onPointerDown={(e) => handleZoomBlockPointerDown(e, zoom)}
              onPointerMove={handleZoomBlockPointerMove}
              onPointerUp={handleZoomBlockPointerUp}
              onClick={(e) => handleZoomBlockClick(e, zoom.id)}
              title={`${formatTime(zoom.startMs)} – ${formatTime(zoom.startMs + zoom.durationMs)} · ${zoom.pct}% — drag an edge to change duration`}
            >
              <div className="tl-piece-edge tl-piece-edge-left" onPointerDown={(e) => handleZoomEdgePointerDown(e, zoom, "left")} onPointerMove={handleZoomEdgePointerMove} onPointerUp={handleZoomEdgePointerUp} />
              <div className="tl-piece-edge tl-piece-edge-right" onPointerDown={(e) => handleZoomEdgePointerDown(e, zoom, "right")} onPointerMove={handleZoomEdgePointerMove} onPointerUp={handleZoomEdgePointerUp} />
              <span className="tl-zoom-pct-badge">{zoom.pct}%</span>
              {selectedZoomId === zoom.id && (
                <div className="tl-zoom-toolbar" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
                  {ZOOM_PCT_PRESETS.map((p) => (
                    <button
                      type="button"
                      key={p}
                      className={p === zoom.pct ? "active" : ""}
                      onClick={() => setZoomPct(zoom.id, p)}
                    >
                      {p}%
                    </button>
                  ))}
                  <button type="button" className="tl-zoom-remove" onClick={() => removeZoom(zoom.id)} title="Remove zoom">
                    <X size={12} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="tl-row">
        <div className={`tl-row-header tl-row-header-camera${cameraHidden ? " disabled" : ""}`}>Camera</div>
        <div
          className={`tl-track tl-track-camera${tool === "cut" ? " tl-track-cut-mode" : ""}${cameraHidden ? " disabled" : ""}`}
          ref={cameraTrackRef}
          onPointerDown={handleCameraTrackPointerDown}
          onPointerMove={handleCameraTrackPointerMove}
          onPointerLeave={handleCameraTrackPointerLeave}
          title={cameraHidden ? "Camera is hidden in the Camera tab — enable it there to edit this track" : undefined}
        >
          {renderCameraPieces()}
          {cutGuide?.track === "camera" && (
            <div className="tl-cut-guide" style={{ left: `${msToPct(cutGuide.ms, durationMs)}%` }} />
          )}
        </div>
      </div>

      <div
        className="tl-playhead"
        style={{ left: `calc(${TL_TRACK_START_PX}px + (100% - ${TL_TRACK_START_PX}px) * ${clamp01(currentMs / durationMs)})` }}
      />
    </div>
    </div>
  );
}
