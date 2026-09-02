import {
  DEFAULT_TIMELINE_ZOOM_TILT,
  ZOOM_PCT_PRESETS,
  type TimelineZoom,
  type TimelineZoomPct,
  type TimelineZoomStyle,
  type TimelineZoomTilt,
} from "../types/models";

/** Snaps to the nearest of the four preset amounts — the only ones the Zoom Effect panel's
 *  buttons ever send, but a saved project could in principle carry some other value (e.g.
 *  a manually-edited save file), so this keeps `pct` honest to the closed set either way. */
function snapToPresetPct(pct: number): TimelineZoomPct {
  return ZOOM_PCT_PRESETS.reduce((closest, p) => (Math.abs(p - pct) < Math.abs(closest - pct) ? p : closest));
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// Degrees each Tilt preset swatch dials in — single-axis presets (top/bottom/left/right)
// use this on one axis, diagonal presets use it on both. Matches the CSS preview swatches
// in ZoomEditPanel (transform: perspective(...) rotateX/rotateY) and the canvas projection
// in PreviewCompositor's project3D — kept as one shared constant so the two never drift.
export const TILT_PRESET_ANGLE_DEG = 14;
// Custom's raw Tilt X/Tilt Y sliders go further than any preset does.
export const TILT_CUSTOM_ANGLE_LIMIT_DEG = 30;

// New zoom blocks (Timeline.tsx's addZoomAt and the auto-zoom-from-clicks generator) start
// tilted "3d" bottom-right instead of a flat "2d" zoom — the style most users reach for
// anyway, so this saves the Style toggle + Tilt preset click on every new block.
export const DEFAULT_NEW_ZOOM_STYLE: TimelineZoomStyle = "3d";
export const DEFAULT_NEW_ZOOM_TILT: TimelineZoomTilt = { xDeg: TILT_PRESET_ANGLE_DEG, yDeg: TILT_PRESET_ANGLE_DEG };

export interface TiltDirectionPreset {
  id: string;
  label: string;
  xDeg: number;
  yDeg: number;
}

/** The Tilt section's quick-pick grid — "Flat" (no tilt) plus the 8 compass directions.
 *  Selecting one just writes its xDeg/yDeg straight onto the zoom's tilt (via setZoomTilt);
 *  there's no separate "which preset is active" field to keep in sync — ZoomEditPanel
 *  highlights whichever swatch's xDeg/yDeg exactly match the current tilt, and none light up
 *  once Custom's sliders move off of them. */
export const TILT_DIRECTION_PRESETS: TiltDirectionPreset[] = [
  { id: "flat", label: "Flat", xDeg: 0, yDeg: 0 },
  { id: "top", label: "Top", xDeg: -TILT_PRESET_ANGLE_DEG, yDeg: 0 },
  { id: "topRight", label: "Top right", xDeg: -TILT_PRESET_ANGLE_DEG, yDeg: TILT_PRESET_ANGLE_DEG },
  { id: "right", label: "Right", xDeg: 0, yDeg: TILT_PRESET_ANGLE_DEG },
  { id: "bottomRight", label: "Bottom right", xDeg: TILT_PRESET_ANGLE_DEG, yDeg: TILT_PRESET_ANGLE_DEG },
  { id: "bottom", label: "Bottom", xDeg: TILT_PRESET_ANGLE_DEG, yDeg: 0 },
  { id: "bottomLeft", label: "Bottom left", xDeg: TILT_PRESET_ANGLE_DEG, yDeg: -TILT_PRESET_ANGLE_DEG },
  { id: "left", label: "Left", xDeg: 0, yDeg: -TILT_PRESET_ANGLE_DEG },
  { id: "topLeft", label: "Top left", xDeg: -TILT_PRESET_ANGLE_DEG, yDeg: -TILT_PRESET_ANGLE_DEG },
];

/** Shared by Timeline.tsx (drag/select mutations) and the Zoom Effect panel's preset
 *  buttons — the single snap-to-preset point for `pct`. */
export function setZoomPct(zooms: TimelineZoom[], id: string, pct: number): TimelineZoom[] {
  const snapped = snapToPresetPct(pct);
  return zooms.map((z) => (z.id === id ? { ...z, pct: snapped } : z));
}

export function setZoomStyle(zooms: TimelineZoom[], id: string, style: TimelineZoomStyle): TimelineZoom[] {
  return zooms.map((z) => (z.id === id ? { ...z, style } : z));
}

/** Merges `patch` onto a zoom block's tilt (both the Tilt preset grid and Custom's sliders
 *  funnel through this), clamping each field back into its allowed range. */
export function setZoomTilt(zooms: TimelineZoom[], id: string, patch: Partial<TimelineZoomTilt>): TimelineZoom[] {
  return zooms.map((z) => {
    if (z.id !== id) return z;
    const next: TimelineZoomTilt = { ...z.tilt, ...patch };
    return {
      ...z,
      tilt: {
        xDeg: clamp(next.xDeg, -TILT_CUSTOM_ANGLE_LIMIT_DEG, TILT_CUSTOM_ANGLE_LIMIT_DEG),
        yDeg: clamp(next.yDeg, -TILT_CUSTOM_ANGLE_LIMIT_DEG, TILT_CUSTOM_ANGLE_LIMIT_DEG),
      },
    };
  });
}

export function removeZoom(zooms: TimelineZoom[], id: string): TimelineZoom[] {
  return zooms.filter((z) => z.id !== id);
}

/** Back-fills fields added to TimelineZoom after some projects were already saved — `style`
 *  and `tilt` (both new) and snaps `pct` back onto the closed preset set. The top-level
 *  `{ ...DEFAULT_TIMELINE_EDIT_SETTINGS, ...project.timeline }` load spread only fills in a
 *  missing *key*, it won't patch fields missing from existing array items, so this is
 *  called once right after that spread. */
export function normalizeTimelineZooms(zooms: TimelineZoom[]): TimelineZoom[] {
  return zooms.map((z) => ({
    ...z,
    style: z.style ?? "2d",
    pct: snapToPresetPct(z.pct),
    tilt: z.tilt ?? { ...DEFAULT_TIMELINE_ZOOM_TILT },
  }));
}
