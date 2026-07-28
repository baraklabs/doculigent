import type { CutRange } from "@shared/types/models";

export function mergeCuts(cuts: CutRange[], rangeStart: number, rangeEnd: number): CutRange[] {
  const sorted = cuts
    .map((c) => ({ start: Math.max(rangeStart, c.start), end: Math.min(rangeEnd, c.end) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);

  const merged: CutRange[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }
  return merged;
}

export function computeKeepRanges(trimStart: number, trimEnd: number, cuts: CutRange[]): [number, number][] {
  const merged = mergeCuts(cuts, trimStart, trimEnd);
  const keep: [number, number][] = [];
  let cursor = trimStart;
  for (const c of merged) {
    if (c.start > cursor) keep.push([cursor, c.start]);
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < trimEnd) keep.push([cursor, trimEnd]);
  return keep;
}

export function advancePastGaps(time: number, ranges: [number, number][]): number | null {
  for (const [start, end] of ranges) {
    if (time < start) return start;
    if (time < end) return time;
  }
  return null;
}
