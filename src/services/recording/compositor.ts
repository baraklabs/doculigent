/**
 * Canvas-drawing ports of FUNCTIONALITY.md §7.2 (letterbox fit-to-canvas) and §7.3
 * (camera-bubble compositing: size%, object-fit:cover crop, circular mask, corner
 * placement). The Rust version did these as two separate steps (resize+crop, then a
 * per-pixel alpha mask); Canvas2D's clip-path does the crop and the mask in one pass,
 * which is why this reads a bit shorter than the original — same visible result.
 *
 * Per FUNCTIONALITY.md §7.4: the camera is drawn **unmirrored** here — only the live
 * setup preview (before recording starts) mirrors, via CSS `scaleX(-1)`, same as before.
 * This webcam's raw getUserMedia frames come in already mirrored left-right (driver-
 * level, same class of issue §7.4 documented for the original native pipeline) — flipped
 * back to natural orientation in `drawCameraBubble` below, in the bubble's own local
 * coordinate space so the crop/mask math above is unaffected.
 */
import type { OverlayConfig } from "@shared/types/models";

export const CANVAS_WIDTH = 1920;
export const CANVAS_HEIGHT = 1080;

export function drawLetterboxed(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  outW: number,
  outH: number
): void {
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, outW, outH);

  const srcW = video.videoWidth || 1;
  const srcH = video.videoHeight || 1;
  const scale = Math.min(outW / srcW, outH / srcH);
  const newW = Math.max(1, Math.round(srcW * scale));
  const newH = Math.max(1, Math.round(srcH * scale));
  const x = Math.floor((outW - newW) / 2);
  const y = Math.floor((outH - newH) / 2);
  ctx.drawImage(video, x, y, newW, newH);
}

export function drawCameraBubble(
  ctx: CanvasRenderingContext2D,
  camera: HTMLVideoElement,
  overlay: OverlayConfig,
  canvasWidth: number,
  canvasHeight: number
): void {
  const bubble = Math.max(1, Math.round((canvasWidth * overlay.sizePct) / 100));
  const x = overlay.corner.endsWith("left") ? 0 : canvasWidth - bubble;
  const y = overlay.corner.startsWith("top") ? 0 : canvasHeight - bubble;

  ctx.save();
  ctx.translate(x, y);
  // From here on, local (0,0) is the bubble's top-left corner, local size is bubble x bubble.

  ctx.beginPath();
  if (overlay.circular) {
    ctx.arc(bubble / 2, bubble / 2, bubble / 2, 0, Math.PI * 2);
  } else {
    ctx.rect(0, 0, bubble, bubble);
  }
  ctx.clip();

  // Mirror back to natural orientation (see the file-level comment above) — done here,
  // inside the clip, so it only flips the sampled pixels and not the crop footprint.
  ctx.translate(bubble, 0);
  ctx.scale(-1, 1);

  // object-fit: cover-equivalent crop of the camera frame into the bubble square.
  const camW = camera.videoWidth || 1;
  const camH = camera.videoHeight || 1;
  const scale = Math.max(bubble / camW, bubble / camH);
  const drawW = camW * scale;
  const drawH = camH * scale;
  const drawX = (bubble - drawW) / 2;
  const drawY = (bubble - drawH) / 2;
  ctx.drawImage(camera, drawX, drawY, drawW, drawH);
  ctx.restore();

  // White border, matching the live preview's `.cam-bubble` CSS — a fresh, unflipped
  // save/translate since a symmetric circle/square outline looks identical either way.
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (overlay.circular) {
    ctx.arc(bubble / 2, bubble / 2, bubble / 2 - 1, 0, Math.PI * 2);
  } else {
    ctx.rect(1, 1, bubble - 2, bubble - 2);
  }
  ctx.stroke();
  ctx.restore();
}
