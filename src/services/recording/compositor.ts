
import type { AreaRect, OverlayConfig } from "@shared/types/models";
import { cameraBubbleRect, OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";

export const CANVAS_WIDTH = OUTPUT_WIDTH;
export const CANVAS_HEIGHT = OUTPUT_HEIGHT;

export function drawLetterboxed(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  outW: number,
  outH: number,
  cropRect?: AreaRect
): void {
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, outW, outH);

  const fullW = video.videoWidth || 1;
  const fullH = video.videoHeight || 1;
  const sx = cropRect ? cropRect.x * fullW : 0;
  const sy = cropRect ? cropRect.y * fullH : 0;
  const srcW = cropRect ? Math.max(1, cropRect.width * fullW) : fullW;
  const srcH = cropRect ? Math.max(1, cropRect.height * fullH) : fullH;

  const scale = Math.min(outW / srcW, outH / srcH);
  const newW = Math.max(1, Math.round(srcW * scale));
  const newH = Math.max(1, Math.round(srcH * scale));
  const x = Math.floor((outW - newW) / 2);
  const y = Math.floor((outH - newH) / 2);
  ctx.drawImage(video, sx, sy, srcW, srcH, x, y, newW, newH);
}

export function drawCameraFullFrame(
  ctx: CanvasRenderingContext2D,
  camera: HTMLVideoElement,
  outW: number,
  outH: number,
  mirror: boolean
): void {
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, outW, outH);

  const camW = camera.videoWidth || 1;
  const camH = camera.videoHeight || 1;
  const scale = Math.min(outW / camW, outH / camH);
  const newW = Math.max(1, Math.round(camW * scale));
  const newH = Math.max(1, Math.round(camH * scale));
  const x = Math.floor((outW - newW) / 2);
  const y = Math.floor((outH - newH) / 2);

  ctx.save();
  if (mirror) {
    ctx.drawImage(camera, x, y, newW, newH);
  } else {
    ctx.translate(x + newW, y);
    ctx.scale(-1, 1);
    ctx.drawImage(camera, 0, 0, newW, newH);
  }
  ctx.restore();
}

export function drawCameraBubble(
  ctx: CanvasRenderingContext2D,
  camera: HTMLVideoElement,
  overlay: OverlayConfig,
  canvasWidth: number,
  canvasHeight: number
): void {
  const { x, y, size: bubble } = cameraBubbleRect(overlay, canvasWidth, canvasHeight);
  ctx.save();
  ctx.translate(x, y);
  drawCameraFrame(ctx, camera, bubble, overlay.circular);
  ctx.restore();
}

export function drawCameraFrame(
  ctx: CanvasRenderingContext2D,
  camera: HTMLVideoElement,
  bubble: number,
  circular: boolean
): void {
  ctx.save();
  ctx.beginPath();
  if (circular) {
    ctx.arc(bubble / 2, bubble / 2, bubble / 2, 0, Math.PI * 2);
  } else {
    ctx.rect(0, 0, bubble, bubble);
  }
  ctx.clip();

  ctx.translate(bubble, 0);
  ctx.scale(-1, 1);

  const camW = camera.videoWidth || 1;
  const camH = camera.videoHeight || 1;
  const scale = Math.max(bubble / camW, bubble / camH);
  const drawW = camW * scale;
  const drawH = camH * scale;
  const drawX = (bubble - drawW) / 2;
  const drawY = (bubble - drawH) / 2;
  ctx.drawImage(camera, drawX, drawY, drawW, drawH);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (circular) {
    ctx.arc(bubble / 2, bubble / 2, bubble / 2 - 1, 0, Math.PI * 2);
  } else {
    ctx.rect(1, 1, bubble - 2, bubble - 2);
  }
  ctx.stroke();
  ctx.restore();
}
