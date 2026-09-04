import type {
  TimelineEffect,
  TimelineEffectBox,
  TimelineEffectKind,
  TimelineEffectShape,
} from "../types/models";
import { BACKGROUND_GRADIENTS } from "../types/models";
import { TILT_PRESET_ANGLE_DEG } from "./timelineZooms";

/** Callout border/label colors — deliberately the loud, high-contrast end of the palette
 *  (a callout exists to be noticed), unlike BACKGROUND_COLORS' backdrop-friendly set. */
export const CALLOUT_COLORS: { id: string; label: string; color: string }[] = [
  { id: "red", label: "Red", color: "#ef4444" },
  { id: "amber", label: "Amber", color: "#f59e0b" },
  { id: "lime", label: "Lime", color: "#84cc16" },
  { id: "cyan", label: "Cyan", color: "#06b6d4" },
  { id: "indigo", label: "Indigo", color: "#6366f1" },
  { id: "magenta", label: "Magenta", color: "#ec4899" },
  { id: "white", label: "White", color: "#ffffff" },
];

export interface EffectQuickPick {
  id: string;
  label: string;
  box: TimelineEffectBox;
}

/** The Effects panel's "Quick pick" grid — the boxes people reach for often enough that
 *  drawing one by hand is busywork: each third of the frame, each half, and the whole
 *  thing. Picking one *retargets the selected box* rather than only ever adding a new one
 *  (see EffectsEditPanel), so these double as a coarse position/size control for a box
 *  that was free-drawn and then needs squaring up. Thirds are inset slightly (2% margins)
 *  so two neighbouring picks read as two boxes rather than one continuous band. */
export const EFFECT_QUICK_PICKS: EffectQuickPick[] = [
  { id: "top-left", label: "Top left", box: { xPct: 2, yPct: 2, wPct: 31, hPct: 31 } },
  { id: "top", label: "Top", box: { xPct: 34.5, yPct: 2, wPct: 31, hPct: 31 } },
  { id: "top-right", label: "Top right", box: { xPct: 67, yPct: 2, wPct: 31, hPct: 31 } },
  { id: "left", label: "Left", box: { xPct: 2, yPct: 34.5, wPct: 31, hPct: 31 } },
  { id: "center", label: "Center", box: { xPct: 34.5, yPct: 34.5, wPct: 31, hPct: 31 } },
  { id: "right", label: "Right", box: { xPct: 67, yPct: 34.5, wPct: 31, hPct: 31 } },
  { id: "bottom-left", label: "Bottom left", box: { xPct: 2, yPct: 67, wPct: 31, hPct: 31 } },
  { id: "bottom", label: "Bottom", box: { xPct: 34.5, yPct: 67, wPct: 31, hPct: 31 } },
  { id: "bottom-right", label: "Bottom right", box: { xPct: 67, yPct: 67, wPct: 31, hPct: 31 } },
];

/** The full-width/full-height picks, kept apart from the 3x3 grid above so the panel can
 *  render them as their own row of wide chips instead of squeezing nine + six cells into
 *  one grid. */
export const EFFECT_BAND_QUICK_PICKS: EffectQuickPick[] = [
  { id: "top-half", label: "Top half", box: { xPct: 0, yPct: 0, wPct: 100, hPct: 50 } },
  { id: "bottom-half", label: "Bottom half", box: { xPct: 0, yPct: 50, wPct: 100, hPct: 50 } },
  { id: "left-half", label: "Left half", box: { xPct: 0, yPct: 0, wPct: 50, hPct: 100 } },
  { id: "right-half", label: "Right half", box: { xPct: 50, yPct: 0, wPct: 50, hPct: 100 } },
  { id: "full", label: "Full frame", box: { xPct: 0, yPct: 0, wPct: 100, hPct: 100 } },
];

/** A box drawn or picked can never be smaller than this on either axis — below it there's
 *  nothing left to grab, and a stray click during free-draw would otherwise leave an
 *  invisible box on the frame the user then can't select to delete. */
export const EFFECT_MIN_SIZE_PCT = 3;

/** Where a brand-new box lands when nothing said where to put it (the panel's plain "Add"
 *  button) — the center third, i.e. EFFECT_QUICK_PICKS' "center". */
export const DEFAULT_EFFECT_BOX: TimelineEffectBox = { xPct: 34.5, yPct: 34.5, wPct: 31, hPct: 31 };

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Keeps a box big enough to see and grab, and stops it being dragged so far off-frame
 *  that no part of it is left on the canvas to grab it by. Sizes are floored, not capped —
 *  a box deliberately wider than the frame (a full-width blur band that overhangs) is
 *  fine. */
export function clampEffectBox(box: TimelineEffectBox): TimelineEffectBox {
  const wPct = Math.max(EFFECT_MIN_SIZE_PCT, box.wPct);
  const hPct = Math.max(EFFECT_MIN_SIZE_PCT, box.hPct);
  return {
    wPct,
    hPct,
    // At least EFFECT_MIN_SIZE_PCT of the box stays on-canvas on each axis.
    xPct: clamp(box.xPct, EFFECT_MIN_SIZE_PCT - wPct, 100 - EFFECT_MIN_SIZE_PCT),
    yPct: clamp(box.yPct, EFFECT_MIN_SIZE_PCT - hPct, 100 - EFFECT_MIN_SIZE_PCT),
  };
}

/** A box built from two free-draw drag corners, in any order (dragging up/left is as valid
 *  as down/right). */
export function boxFromCorners(a: { xPct: number; yPct: number }, b: { xPct: number; yPct: number }): TimelineEffectBox {
  return clampEffectBox({
    xPct: Math.min(a.xPct, b.xPct),
    yPct: Math.min(a.yPct, b.yPct),
    wPct: Math.abs(b.xPct - a.xPct),
    hPct: Math.abs(b.yPct - a.yPct),
  });
}

// A new callout/blur block's window, when whatever created it didn't say — long enough to
// read (or to hide something through a sentence of narration) without immediately needing a
// trim. Matched to ZOOM_DEFAULT_DURATION_MS's order of magnitude on purpose: the two tracks
// sit next to each other and blocks of wildly different default lengths read as a bug.
export const EFFECT_DEFAULT_DURATION_MS = 2500;
// Trim floor, same role as Timeline's MIN_ZOOM_MS — below this a block has no body left to
// grab between its own two edge handles.
export const MIN_EFFECT_MS = 300;
// How long each side of a callout's "Popout" animation takes — the entrance ramp up to full
// size/opacity, and the exit ramp back down, each get this long. Shared between the draw
// loop (which times the animation off it) and the panel (which has no reason to know it,
// but keeping it one constant here avoids a second copy drifting out of sync).
export const EFFECT_POPUP_MS = 320;

// A fresh callout's own default marquee gradient — "Candy", pulled from the same preset
// list the panel's own gradient swatches offer rather than duplicating its hex codes here.
const CALLOUT_DEFAULT_MARQUEE_GRADIENT = BACKGROUND_GRADIENTS.find((g) => g.id === "candy") ?? BACKGROUND_GRADIENTS[0];

/** A fresh effect of `kind`, spanning [startMs, startMs + durationMs). Both blocks share one
 *  shape (see TimelineEffect) — the defaults just start each one at what that block is nearly
 *  always used for: a blur is a plain un-dimmed rectangle strong enough to actually hide
 *  text; a callout is a red rounded rectangle, dimmed most of the way down, that pops out
 *  with a bottom tilt and a thick chasing candy-gradient marquee — the "eye-catching by
 *  default" combination, dialed back from there rather than built up. */
export function createEffect(
  kind: TimelineEffectKind,
  box: TimelineEffectBox = DEFAULT_EFFECT_BOX,
  startMs = 0,
  durationMs = EFFECT_DEFAULT_DURATION_MS
): TimelineEffect {
  const isCallout = kind === "callout";
  return {
    id: crypto.randomUUID(),
    kind,
    box: clampEffectBox(box),
    shape: "rect",
    startMs: Math.max(0, startMs),
    durationMs: Math.max(MIN_EFFECT_MS, durationMs),
    color: CALLOUT_COLORS[0].color,
    dimPct: isCallout ? 70 : 0,
    borderPct: isCallout ? 3 : 0,
    cornerPct: 6,
    label: "",
    popupAnim: isCallout,
    popupZoomPct: 150,
    tilt: isCallout ? { xDeg: TILT_PRESET_ANGLE_DEG, yDeg: 0 } : { xDeg: 0, yDeg: 0 },
    marquee: isCallout,
    marqueeStyle: "orbit",
    marqueeColorMode: "gradient",
    marqueeColor: CALLOUT_COLORS[0].color,
    marqueeGradientFrom: CALLOUT_DEFAULT_MARQUEE_GRADIENT.from,
    marqueeGradientTo: CALLOUT_DEFAULT_MARQUEE_GRADIENT.to,
    blurPct: 60,
    pixelate: false,
  };
}

export function addEffect(effects: TimelineEffect[], effect: TimelineEffect): TimelineEffect[] {
  return [...effects, effect];
}

/** Merges `patch` onto one effect, re-clamping its box so a patch that came straight from
 *  a pointer drag can't push it somewhere unrecoverable. */
export function updateEffect(effects: TimelineEffect[], id: string, patch: Partial<TimelineEffect>): TimelineEffect[] {
  return effects.map((e) => {
    if (e.id !== id) return e;
    const next = { ...e, ...patch };
    return patch.box ? { ...next, box: clampEffectBox(patch.box) } : next;
  });
}

export function removeEffect(effects: TimelineEffect[], id: string): TimelineEffect[] {
  return effects.filter((e) => e.id !== id);
}

/** Whether an effect paints at `ms` on the edited timeline — its own block's window, half
 *  open at the end so two blocks butted flush together never both paint on the seam. */
export function isEffectActiveAt(effect: TimelineEffect, ms: number): boolean {
  return ms >= effect.startMs && ms < effect.startMs + effect.durationMs;
}

/** Back-fills fields onto effects saved by an older build, the same way
 *  normalizeTimelineZooms does for zoom blocks — the load-time
 *  `{ ...DEFAULT_TIMELINE_EDIT_SETTINGS, ...project.timeline }` spread only fills in a
 *  missing top-level key, never fields missing from entries inside an array. */
export function normalizeTimelineEffects(effects: TimelineEffect[]): TimelineEffect[] {
  return effects.map((e) => {
    const template = createEffect(e.kind === "blur" ? "blur" : "callout");
    return {
      ...template,
      ...e,
      id: e.id ?? template.id,
      kind: (e.kind === "blur" ? "blur" : "callout") as TimelineEffectKind,
      shape: (e.shape === "ellipse" ? "ellipse" : "rect") as TimelineEffectShape,
      box: clampEffectBox({ ...template.box, ...(e.box ?? {}) }),
      // Both were nullable ("whole video") before the Effects tracks existed, and a saved
      // project can still carry that — a null start is simply the beginning, and a null
      // duration becomes a normal-length block the user can stretch back out on the track.
      startMs: Number.isFinite(e.startMs) ? Math.max(0, e.startMs) : 0,
      durationMs: Number.isFinite(e.durationMs) ? Math.max(MIN_EFFECT_MS, e.durationMs) : EFFECT_DEFAULT_DURATION_MS,
    };
  });
}
