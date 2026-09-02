import { ZOOM_PCT_PRESETS, type TimelineZoom, type TimelineZoomPct, type TimelineZoomStyle } from "../types/models";

/** Snaps to the nearest of the four preset amounts — the only ones the Zoom Effect panel's
 *  buttons ever send, but a saved project could in principle carry some other value (e.g.
 *  a manually-edited save file), so this keeps `pct` honest to the closed set either way. */
function snapToPresetPct(pct: number): TimelineZoomPct {
  return ZOOM_PCT_PRESETS.reduce((closest, p) => (Math.abs(p - pct) < Math.abs(closest - pct) ? p : closest));
}

/** Shared by Timeline.tsx (drag/select mutations) and the Zoom Effect panel's preset
 *  buttons — the single snap-to-preset point for `pct`. */
export function setZoomPct(zooms: TimelineZoom[], id: string, pct: number): TimelineZoom[] {
  const snapped = snapToPresetPct(pct);
  return zooms.map((z) => (z.id === id ? { ...z, pct: snapped } : z));
}

export function setZoomStyle(zooms: TimelineZoom[], id: string, style: TimelineZoomStyle): TimelineZoom[] {
  return zooms.map((z) => (z.id === id ? { ...z, style } : z));
}

export function removeZoom(zooms: TimelineZoom[], id: string): TimelineZoom[] {
  return zooms.filter((z) => z.id !== id);
}

/** Back-fills fields added to TimelineZoom after some projects were already saved — `style`
 *  (new) and snaps `pct` back onto the closed preset set. The top-level
 *  `{ ...DEFAULT_TIMELINE_EDIT_SETTINGS, ...project.timeline }` load spread only fills in a
 *  missing *key*, it won't patch fields missing from existing array items, so this is
 *  called once right after that spread. */
export function normalizeTimelineZooms(zooms: TimelineZoom[]): TimelineZoom[] {
  return zooms.map((z) => ({ ...z, style: z.style ?? "2d", pct: snapToPresetPct(z.pct) }));
}
