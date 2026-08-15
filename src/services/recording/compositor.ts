
import type { AreaRect, CameraBubbleShape, OverlayConfig } from "@shared/types/models";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";

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
  bubbleSize: { width: number; height: number },
  shape: CameraBubbleShape,
  roundedCorners: boolean,
  canvasWidth: number,
  canvasHeight: number
): void {
  const { width, height } = bubbleSize;
  const x = overlay.corner.endsWith("left") ? 0 : canvasWidth - width;
  const y = overlay.corner.startsWith("top") ? 0 : canvasHeight - height;
  ctx.save();
  ctx.translate(x, y);
  drawCameraFrame(ctx, camera, width, height, shape, roundedCorners, overlay.mirrorCamera);
  ctx.restore();
}

export function drawCameraRaw(ctx: CanvasRenderingContext2D, camera: HTMLVideoElement, outW: number, outH: number): void {
  ctx.drawImage(camera, 0, 0, outW, outH);
}

export function drawCameraFrame(
  ctx: CanvasRenderingContext2D,
  camera: HTMLVideoElement,
  width: number,
  height: number,
  shape: CameraBubbleShape,
  roundedCorners: boolean,
  mirror: boolean
): void {
  const rounded = shape !== "round" && roundedCorners;
  const radius = Math.min(20, width / 2, height / 2);

  ctx.save();
  ctx.beginPath();
  if (shape === "round") {
    ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else if (rounded) {
    ctx.roundRect(0, 0, width, height, radius);
  } else {
    ctx.rect(0, 0, width, height);
  }
  ctx.clip();

  const camW = camera.videoWidth || 1;
  const camH = camera.videoHeight || 1;
  const scale = Math.max(width / camW, height / camH);
  const drawW = camW * scale;
  const drawH = camH * scale;
  const drawX = (width - drawW) / 2;
  const drawY = (height - drawH) / 2;
  if (mirror) {
    ctx.drawImage(camera, drawX, drawY, drawW, drawH);
  } else {
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(camera, drawX, drawY, drawW, drawH);
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (shape === "round") {
    ctx.ellipse(width / 2, height / 2, width / 2 - 1, height / 2 - 1, 0, 0, Math.PI * 2);
  } else if (rounded) {
    ctx.roundRect(1, 1, width - 2, height - 2, radius);
  } else {
    ctx.rect(1, 1, width - 2, height - 2);
  }
  ctx.stroke();
  ctx.restore();
}
