/**
 * Types for the screen-annotation overlay (Record page's "Draw on screen" tool) — an
 * Epic Pen-style system-wide drawing layer, not tied to the compositing canvas used for
 * the camera bubble. See electron/main/annotationWindow.ts for the two-window design
 * (a full-virtual-desktop transparent draw surface + a small always-interactive floating
 * toolbar) this backs.
 */

export type AnnotationTool = "pointer" | "pen" | "circle" | "square" | "arrow";

/** Fixed palette rather than a full color picker — matches the "choose from a set of
 *  colors" ask; keeps the toolbar small. */
export const ANNOTATION_COLORS = ["#e63946", "#f77f00", "#ffd60a", "#2ecc71", "#3a86ff", "#111111"] as const;

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationStroke {
  id: string;
  tool: "pen" | "circle" | "square" | "arrow";
  color: string;
  /** Pen: every point sampled along the drag. Shapes: exactly two points, start and
   *  end (a bounding box for circle/square, the two endpoints for arrow). */
  points: AnnotationPoint[];
}

export interface AnnotationState {
  tool: AnnotationTool;
  color: string;
}

export type AnnotationCommand = "undo" | "redo" | "clear";
