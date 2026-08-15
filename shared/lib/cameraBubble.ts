import type { CameraBubbleShape, OverlayConfig } from "../types/models";

export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;

export function cameraBubbleRect(
  overlay: Pick<OverlayConfig, "corner" | "sizePct">,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number; size: number } {
  const size = Math.max(1, Math.round((canvasWidth * overlay.sizePct) / 100));
  const x = overlay.corner.endsWith("left") ? 0 : canvasWidth - size;
  const y = overlay.corner.startsWith("top") ? 0 : canvasHeight - size;
  return { x, y, size };
}

const RECT_ASPECT = 1.6;

export function cameraBubbleDimensions(shape: CameraBubbleShape, size: number): { width: number; height: number } {
  if (shape === "rectangle") return { width: Math.round(size * RECT_ASPECT), height: size };
  if (shape === "rectangle-vertical") return { width: size, height: Math.round(size * RECT_ASPECT) };
  return { width: size, height: size };
}

export function cameraBubbleRectForShape(
  overlay: Pick<OverlayConfig, "corner" | "sizePct">,
  shape: CameraBubbleShape,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number; width: number; height: number } {
  const { size } = cameraBubbleRect(overlay, canvasWidth, canvasHeight);
  const { width, height } = cameraBubbleDimensions(shape, size);
  const x = overlay.corner.endsWith("left") ? 0 : canvasWidth - width;
  const y = overlay.corner.startsWith("top") ? 0 : canvasHeight - height;
  return { x, y, width, height };
}
