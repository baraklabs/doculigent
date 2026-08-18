
import { OUTPUT_HEIGHT, OUTPUT_WIDTH } from "@shared/lib/cameraBubble";

export const CANVAS_WIDTH = OUTPUT_WIDTH;
export const CANVAS_HEIGHT = OUTPUT_HEIGHT;

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

export function drawCameraRaw(ctx: CanvasRenderingContext2D, camera: HTMLVideoElement, outW: number, outH: number): void {
  ctx.drawImage(camera, 0, 0, outW, outH);
}
