import type { TimelineSegment } from "../types/models";

/** An empty `segments` array means "not cut yet" — the whole timeline as one segment,
 *  inheriting master settings (`settings: null`). Mirrors effectiveClips' own fabricated-
 *  default convention (shared/lib/timelineClips.ts) so callers never special-case it. */
export function effectiveSegments<T>(segments: TimelineSegment<T>[], durationMs: number): TimelineSegment<T>[] {
  if (segments.length > 0) return segments;
  if (durationMs <= 0) return [];
  return [{ id: "__default", startMs: 0, endMs: durationMs, settings: null }];
}

/** Whichever segment currently covers `ms` — segments are always contiguous/non-
 *  overlapping by construction (see splitSegmentAtPoint/deleteSegment below), so normally
 *  exactly one matches; the last match in array order wins if that invariant is ever
 *  violated, same defensive convention as resolveClipAt. */
export function resolveSegmentAt<T>(segments: TimelineSegment<T>[], ms: number): TimelineSegment<T> | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (ms >= s.startMs && ms < s.endMs) return s;
  }
  return null;
}

/** The settings that actually apply at `currentMs` — the covering segment's own override,
 *  if it has one, else the tab's master settings. The one function PreviewCompositor calls
 *  per frame for Cursor/Layout/Sound. */
export function resolveSegmentSettings<T>(
  segments: TimelineSegment<T>[],
  master: T,
  currentMs: number,
  durationMs: number
): T {
  const seg = resolveSegmentAt(effectiveSegments(segments, durationMs), currentMs);
  return seg?.settings ?? master;
}

const MIN_SEGMENT_MS = 20;

/** Splits the effective segment covering `ms` into two, in place of it. Both halves keep
 *  the parent's exact `settings` value — a `null` (inherits master) split stays `null` on
 *  both sides; a customized parent's override is spread-cloned (not shared by reference)
 *  onto both children, so splitting a customized cut never resets it. No-op if no segment
 *  covers that point or the split would produce a degenerate (near-zero-width) piece. */
export function splitSegmentAtPoint<T>(
  segments: TimelineSegment<T>[],
  ms: number,
  durationMs: number
): TimelineSegment<T>[] {
  const effective = effectiveSegments(segments, durationMs);
  const idx = effective.findIndex((s) => ms > s.startMs && ms < s.endMs);
  if (idx === -1) return segments;
  const seg = effective[idx];
  if (ms - seg.startMs < MIN_SEGMENT_MS || seg.endMs - ms < MIN_SEGMENT_MS) return segments;
  const cloneSettings = (s: T | null): T | null => (s === null ? null : { ...s });
  const first: TimelineSegment<T> = { id: crypto.randomUUID(), startMs: seg.startMs, endMs: ms, settings: cloneSettings(seg.settings) };
  const second: TimelineSegment<T> = { id: crypto.randomUUID(), startMs: ms, endMs: seg.endMs, settings: cloneSettings(seg.settings) };
  return [...effective.slice(0, idx), first, second, ...effective.slice(idx + 1)];
}

/** Sets segment `id`'s own `settings` — `null` to revert it back to inheriting master, a
 *  real value to give it its own override. No-op if `id` isn't found (e.g. a stale
 *  selection after the segment was deleted elsewhere). */
export function setSegmentSettings<T>(segments: TimelineSegment<T>[], id: string, settings: T | null): TimelineSegment<T>[] {
  return segments.map((s) => (s.id === id ? { ...s, settings } : s));
}

/** Removes segment `id` and extends its right neighbor back to cover the gap (or, if it
 *  was the last segment, extends the previous one forward instead) — this single function
 *  is both "delete a cut" and "merge back": segments stay contiguous by construction, so no
 *  separate merge gesture is needed. No-op if `id` isn't found or it's the only segment
 *  left (nothing to merge into). */
export function deleteSegment<T>(segments: TimelineSegment<T>[], id: string): TimelineSegment<T>[] {
  const idx = segments.findIndex((s) => s.id === id);
  if (idx === -1 || segments.length <= 1) return segments;
  const removed = segments[idx];
  const next = segments.slice();
  if (idx < next.length - 1) {
    next[idx + 1] = { ...next[idx + 1], startMs: removed.startMs };
  } else {
    next[idx - 1] = { ...next[idx - 1], endMs: removed.endMs };
  }
  next.splice(idx, 1);
  return next;
}
