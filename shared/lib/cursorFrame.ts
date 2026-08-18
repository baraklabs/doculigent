import type { CursorMetadata } from "../types/models";
import { OUTPUT_WIDTH, OUTPUT_HEIGHT } from "./cameraBubble";

export function frameDimensions(metadata: CursorMetadata): { width: number; height: number } {
  if (metadata.capture.kind === "area" && metadata.capture.bounds) {
    return {
      width: Math.max(2, Math.round(metadata.capture.bounds.width * metadata.capture.scaleFactor)),
      height: Math.max(2, Math.round(metadata.capture.bounds.height * metadata.capture.scaleFactor)),
    };
  }
  return { width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT };
}

export function toFrameCoords(metadata: CursorMetadata, x: number, y: number): { x: number; y: number } | null {
  const b = metadata.capture.bounds;
  if (!b) return null;
  const physX = (x - b.x) * metadata.capture.scaleFactor;
  const physY = (y - b.y) * metadata.capture.scaleFactor;

  if (metadata.capture.kind === "area") {
    return { x: physX, y: physY };
  }

  const physW = b.width * metadata.capture.scaleFactor;
  const physH = b.height * metadata.capture.scaleFactor;
  const scale = Math.min(OUTPUT_WIDTH / physW, OUTPUT_HEIGHT / physH);
  const padX = (OUTPUT_WIDTH - physW * scale) / 2;
  const padY = (OUTPUT_HEIGHT - physH * scale) / 2;
  return { x: padX + physX * scale, y: padY + physY * scale };
}
