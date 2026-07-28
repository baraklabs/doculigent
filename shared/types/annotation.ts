/**
 * Types for the screen-annotation overlay (Record page's "Draw on screen" tool) — an
 * Epic Pen-style system-wide drawing layer, not tied to the compositing canvas used for
 * the camera bubble. See electron/main/annotationWindow.ts for the two-window design
 * (a full-virtual-desktop transparent draw surface + a small always-interactive floating
 * toolbar) this backs.
 */

export type AnnotationTool = "pointer" | "pen" | "circle" | "square" | "arrow" | "line";

/** Fixed palette rather than a full color picker — matches the "choose from a set of
 *  colors" ask; keeps the toolbar small. */
export const ANNOTATION_COLORS = ["#e63946", "#f77f00", "#ffd60a", "#2ecc71", "#3a86ff", "#111111"] as const;

export const ANNOTATION_WIDTHS = [2, 4, 8, 14, 20] as const;
export type AnnotationWidth = (typeof ANNOTATION_WIDTHS)[number];

/** Opacity slider bounds — a plain 0–1 range rather than presets. */
export const ANNOTATION_OPACITY_MIN = 0.1;
export const ANNOTATION_OPACITY_MAX = 1;
export const ANNOTATION_OPACITY_STEP = 0.05;

/** Fade slider stops. 0 ("Off") means strokes persist until cleared/undone — the
 *  pre-existing behavior; the rest are seconds-until-gone. */
export const ANNOTATION_FADE_OPTIONS = [0, 2000, 3000, 5000, 10000] as const;
export type AnnotationFadeMs = (typeof ANNOTATION_FADE_OPTIONS)[number];

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationStroke {
  id: string;
  tool: "pen" | "circle" | "square" | "arrow" | "line";
  color: string;
  width: number;
  /** 0–1; baked in at creation like color/width so later toolbar changes don't affect it. */
  opacity: number;
  /** ms since epoch, set when the stroke is finalized — the fade clock's zero point. */
  createdAt: number;
  /** 0 disables fading for this stroke. */
  fadeMs: number;
  /** Pen: every point sampled along the drag. Shapes: exactly two points, start and
   *  end (a bounding box for circle/square, the two endpoints for arrow/line). */
  points: AnnotationPoint[];
}

export interface AnnotationState {
  tool: AnnotationTool;
  color: string;
  width: number;
  opacity: number;
  fadeMs: number;
}

export type AnnotationCommand = "undo" | "redo" | "clear";
