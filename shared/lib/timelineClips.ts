import type { TimelineClip } from "../types/models";

/** An empty `clips` array means "not edited yet" — one clip spanning the whole recording
 *  (or, once Clips/Camera need to line up — see `defaultSourceStart` below — the part of
 *  it that's shared with the other track), at timeline position `defaultTimelineStart`
 *  (0 for both the Clips/screen track and the Camera track: both start together on the
 *  shared edited clock by default now — see `defaultSourceStart`). Everything below takes
 *  the *effective* list (this, if `clips` is empty) so callers never need their own
 *  special-case for the unedited state.
 *
 *  `maxTimelineEnd`, when given, caps how far past `defaultTimelineStart` the fabricated
 *  default piece is allowed to reach — both the Clips and Camera tracks pass the same
 *  shared "aligned length" here (the shorter of what's left in each file once
 *  `defaultSourceStart` is trimmed off), so their default pieces always end together too,
 *  not just start together.
 *
 *  `defaultSourceStart`, when given, is where in the *source* file the default piece
 *  starts (still at edited position `defaultTimelineStart`) — the Clips/screen track
 *  passes its recorded EditProjectMedia.sideClipStartOffsetMs here, trimming off its own
 *  camera-less lead-in (the screen recording always starts before the camera file's own
 *  t=0 — see sideClipStartOffsetMs's own doc comment) so it starts, on the edited
 *  timeline, exactly where the Camera track's real content does. That lead-in remains
 *  real, recoverable footage — same as any other trimmed clip, its sourceStart can be
 *  dragged back out to 0 to reveal it — just not shown by default. */
export function effectiveClips(
  clips: TimelineClip[],
  sourceDurationMs: number,
  defaultTimelineStart = 0,
  maxTimelineEnd?: number,
  defaultSourceStart = 0
): TimelineClip[] {
  if (clips.length > 0) return clips;
  const availableMs = sourceDurationMs - defaultSourceStart;
  if (availableMs <= 0) return [];
  const cappedDurationMs =
    maxTimelineEnd !== undefined
      ? Math.min(availableMs, Math.max(0, maxTimelineEnd - defaultTimelineStart))
      : availableMs;
  if (cappedDurationMs <= 0) return [];
  return [
    {
      id: "__default",
      sourceStart: defaultSourceStart,
      sourceEnd: defaultSourceStart + cappedDurationMs,
      timelineStart: defaultTimelineStart,
    },
  ];
}

/** The edited timeline's own length — the rightmost edge of any clip's timeline span, not
 *  a sum (clips can overlap, or leave gaps, so there's no single running total). */
export function totalClipsExtentMs(clips: TimelineClip[]): number {
  return clips.reduce((max, c) => Math.max(max, c.timelineStart + Math.max(0, c.sourceEnd - c.sourceStart)), 0);
}

/** Whichever clip currently claims `editedMs`, if any — the *last* match in array order
 *  wins where pieces overlap (see TimelineClip's doc comment). Returns the corresponding
 *  source position too, or null for a gap (nothing there at all). */
export function resolveClipAt(clips: TimelineClip[], editedMs: number): { clip: TimelineClip; sourceMs: number } | null {
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    const dur = Math.max(0, c.sourceEnd - c.sourceStart);
    if (editedMs >= c.timelineStart && editedMs < c.timelineStart + dur) {
      return { clip: c, sourceMs: c.sourceStart + (editedMs - c.timelineStart) };
    }
  }
  return null;
}

/** The reverse of resolveClipAt — where a raw source-time position (e.g. a recorded click
 *  timestamp, which is always source time, never edited time) ends up on the edited
 *  timeline, via whichever clip currently covers it. Returns null if that stretch of the
 *  source isn't visible anywhere in the edited output (cut out, or simply not yet included
 *  by `clips`). */
export function sourceToEditedMs(clips: TimelineClip[], sourceMs: number): number | null {
  for (const c of clips) {
    if (sourceMs >= c.sourceStart && sourceMs < c.sourceEnd) {
      return c.timelineStart + (sourceMs - c.sourceStart);
    }
  }
  return null;
}

/** Splits whichever clip currently covers `sourceMs` (matched by source range, independent
 *  of overlap/stacking) into two, in place of it in the array — the second half's
 *  `timelineStart` immediately follows the first's, same as before the split. No-op if no
 *  clip covers that point or the split would produce a degenerate (near-zero-width) piece. */
export function splitClipAtSource(clips: TimelineClip[], sourceMs: number): TimelineClip[] {
  const idx = clips.findIndex((c) => sourceMs > c.sourceStart && sourceMs < c.sourceEnd);
  if (idx === -1) return clips;
  const clip = clips[idx];
  const MIN_PIECE_MS = 20;
  if (sourceMs - clip.sourceStart < MIN_PIECE_MS || clip.sourceEnd - sourceMs < MIN_PIECE_MS) return clips;
  const splitOffset = sourceMs - clip.sourceStart;
  const first: TimelineClip = {
    id: crypto.randomUUID(),
    sourceStart: clip.sourceStart,
    sourceEnd: sourceMs,
    timelineStart: clip.timelineStart,
  };
  const second: TimelineClip = {
    id: crypto.randomUUID(),
    sourceStart: sourceMs,
    sourceEnd: clip.sourceEnd,
    timelineStart: clip.timelineStart + splitOffset,
  };
  return [...clips.slice(0, idx), first, second, ...clips.slice(idx + 1)];
}

/** Removes a clip entirely — positions are independent, so nothing ripples to fill the
 *  space it leaves behind; that stretch just becomes a gap (or reverts to whatever other
 *  clip, if any, was already overlapping it underneath). */
export function deleteClip(clips: TimelineClip[], id: string): TimelineClip[] {
  return clips.filter((c) => c.id !== id);
}

/** Brings a clip to the front of the stacking order (the end of the array) without
 *  changing its position — called when a drag on it starts, so whatever's being moved is
 *  always what's on top of anything it ends up overlapping. */
export function bringClipToFront(clips: TimelineClip[], id: string): TimelineClip[] {
  const idx = clips.findIndex((c) => c.id === id);
  if (idx === -1 || idx === clips.length - 1) return clips;
  const next = clips.slice();
  const [moved] = next.splice(idx, 1);
  next.push(moved);
  return next;
}
