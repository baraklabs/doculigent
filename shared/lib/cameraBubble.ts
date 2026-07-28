import type { OverlayConfig } from "../types/models";

/** The fixed output frame every recording is composited/letterboxed into, regardless of
 *  the captured display's native resolution or which capture pipeline produced it — kept
 *  here (rather than in the renderer-only compositor.ts) so main-process code building the
 *  gdigrab pipeline can share it without pulling in DOM types. */
export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;

/** Pure pixel geometry for the camera bubble — square side length and top-left corner
 *  within a `canvasWidth` x `canvasHeight` frame. Shared by the canvas compositor
 *  (src/services/recording/compositor.ts, still used for non-gdigrab recordings) and the
 *  main-process ffmpeg overlay filter (electron/main/native/ffmpeg.ts), so the two capture
 *  paths place the bubble identically instead of two hand-kept copies of the same formula. */
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
