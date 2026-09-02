
import { pipeline, RawImage } from "@huggingface/transformers";
import type { CameraBlurLevel } from "@shared/types/models";

const MODEL_ID = "Xenova/modnet";
const INFER_SIZE = 256;
const MASK_FEATHER_PX = 3;
const OUTPUT_FPS = 30;

const BLUR_PX: Record<Exclude<CameraBlurLevel, "none">, number> = {
  soft: 8,
  aggressive: 22,
};

type Segmenter = Awaited<ReturnType<typeof pipeline<"image-segmentation">>>;

let segmenterPromise: Promise<Segmenter> | null = null;

function loadSegmenter(): Promise<Segmenter> {
  if (!segmenterPromise) {
    const hasWebGpu = typeof navigator !== "undefined" && !!(navigator as unknown as { gpu?: unknown }).gpu;
    const first = hasWebGpu ? "webgpu" : "wasm";
    segmenterPromise = pipeline("image-segmentation", MODEL_ID, { device: first }).catch((err) => {
      if (first !== "wasm") return pipeline("image-segmentation", MODEL_ID, { device: "wasm" });
      throw err;
    });
  }
  return segmenterPromise;
}

export function preloadCameraBlurModel(): Promise<void> {
  return loadSegmenter().then(
    () => undefined,
    () => undefined
  );
}

/** One inference pass: draws `source`'s current frame at INFER_SIZE, segments it, and
 *  returns a feathered person-alpha mask (RGB 255/255/255, alpha = segmentation
 *  confidence) sized to that same downscaled frame — or null on a transient failure
 *  (caller keeps showing its previous mask, same tolerance as a dropped video frame).
 *  Shared by applyCameraBlur (blurs behind the mask) and startCameraSegmentation (cuts
 *  the background out entirely via the mask's own alpha) so the two can't drift apart. */
async function segmentFrame(
  segmenter: Segmenter,
  source: HTMLVideoElement,
  canvases: {
    infer: HTMLCanvasElement;
    inferCtx: CanvasRenderingContext2D;
    rawMask: HTMLCanvasElement;
    rawMaskCtx: CanvasRenderingContext2D;
    featheredMask: HTMLCanvasElement;
    featheredMaskCtx: CanvasRenderingContext2D;
  }
): Promise<HTMLCanvasElement | null> {
  const vw = source.videoWidth;
  const vh = source.videoHeight;
  if (!vw || !vh) return null;

  const { infer, inferCtx, rawMask, rawMaskCtx, featheredMask, featheredMaskCtx } = canvases;
  const scale = INFER_SIZE / Math.max(vw, vh);
  const iw = Math.max(1, Math.round(vw * scale));
  const ih = Math.max(1, Math.round(vh * scale));
  if (infer.width !== iw || infer.height !== ih) {
    infer.width = iw;
    infer.height = ih;
  }
  inferCtx.drawImage(source, 0, 0, iw, ih);

  try {
    const [{ mask }] = await segmenter(RawImage.fromCanvas(infer));
    const { width: mw, height: mh, data } = mask;
    rawMask.width = mw;
    rawMask.height = mh;
    const imageData = rawMaskCtx.createImageData(mw, mh);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      imageData.data[j] = 255;
      imageData.data[j + 1] = 255;
      imageData.data[j + 2] = 255;
      imageData.data[j + 3] = data[i];
    }
    rawMaskCtx.putImageData(imageData, 0, 0);

    featheredMask.width = mw;
    featheredMask.height = mh;
    featheredMaskCtx.clearRect(0, 0, mw, mh);
    featheredMaskCtx.filter = `blur(${MASK_FEATHER_PX}px)`;
    featheredMaskCtx.drawImage(rawMask, 0, 0);
    featheredMaskCtx.filter = "none";
    return featheredMask;
  } catch {
    return null;
  }
}

function make2dCanvas(attrs?: CanvasRenderingContext2DSettings): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", attrs) as CanvasRenderingContext2D;
  return { canvas, ctx };
}

export interface CameraBlurHandle {
  stream: MediaStream;
  stop(): void;
}

export function applyCameraBlur(sourceStream: MediaStream, level: Exclude<CameraBlurLevel, "none">): CameraBlurHandle {
  const blurPx = BLUR_PX[level];

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = sourceStream;
  video.play().catch(() => {});

  const { canvas: inferCanvas, ctx: inferCtx } = make2dCanvas({ willReadFrequently: true });
  const { canvas: rawMaskCanvas, ctx: rawMaskCtx } = make2dCanvas();
  const { canvas: featheredMaskCanvas, ctx: featheredMaskCtx } = make2dCanvas();
  const personCanvas = document.createElement("canvas");
  const personCtx = personCanvas.getContext("2d") as CanvasRenderingContext2D;
  const outCanvas = document.createElement("canvas");
  const outCtx = outCanvas.getContext("2d") as CanvasRenderingContext2D;

  let stopped = false;
  let renderRafId = 0;
  let lastMask: HTMLCanvasElement | null = null;

  async function inferLoop(): Promise<void> {
    const segmenter = await loadSegmenter().catch(() => null);
    while (!stopped) {
      if (!segmenter || !video.videoWidth || !video.videoHeight) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const mask = await segmentFrame(segmenter, video, {
        infer: inferCanvas,
        inferCtx,
        rawMask: rawMaskCanvas,
        rawMaskCtx,
        featheredMask: featheredMaskCanvas,
        featheredMaskCtx,
      });
      if (mask) lastMask = mask;
    }
  }

  function renderLoop(): void {
    if (stopped) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh) {
      if (outCanvas.width !== vw || outCanvas.height !== vh) {
        outCanvas.width = vw;
        outCanvas.height = vh;
        personCanvas.width = vw;
        personCanvas.height = vh;
      }

      outCtx.filter = `blur(${blurPx}px)`;
      outCtx.drawImage(video, 0, 0, vw, vh);
      outCtx.filter = "none";

      if (lastMask) {
        personCtx.clearRect(0, 0, vw, vh);
        personCtx.drawImage(video, 0, 0, vw, vh);
        personCtx.globalCompositeOperation = "destination-in";
        personCtx.drawImage(lastMask, 0, 0, vw, vh);
        personCtx.globalCompositeOperation = "source-over";
        outCtx.drawImage(personCanvas, 0, 0);
      }
    }
    renderRafId = requestAnimationFrame(renderLoop);
  }

  inferLoop();
  renderLoop();

  const stream = outCanvas.captureStream(OUTPUT_FPS);
  return {
    stream,
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(renderRafId);
      video.pause();
      video.srcObject = null;
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

export interface CameraSegmentationHandle {
  /** Latest available person-alpha mask (see segmentFrame), or null before the first
   *  inference completes. Same aspect ratio as `source`'s frame, just downscaled to
   *  INFER_SIZE — the caller crops/scales it to match however it's drawing `source`. */
  getMask(): HTMLCanvasElement | null;
  stop(): void;
}

/** Runs the same modnet segmentation loop as applyCameraBlur, but reads directly off
 *  `source` (no capture-stream/video roundtrip) and hands back the raw mask instead of
 *  a blurred composite. A capture-stream video can't carry alpha — encoded video frames
 *  are always opaque — so real background *removal* (as opposed to blurring it) has to
 *  happen on the caller's own canvas: PreviewCompositor draws `source` into the camera
 *  bubble itself and cuts the background out live via destination-in against this mask,
 *  which lets whatever's already painted behind the bubble show through. */
export function startCameraSegmentation(source: HTMLVideoElement): CameraSegmentationHandle {
  const { canvas: inferCanvas, ctx: inferCtx } = make2dCanvas({ willReadFrequently: true });
  const { canvas: rawMaskCanvas, ctx: rawMaskCtx } = make2dCanvas();
  const { canvas: featheredMaskCanvas, ctx: featheredMaskCtx } = make2dCanvas();

  let stopped = false;
  let lastMask: HTMLCanvasElement | null = null;

  async function inferLoop(): Promise<void> {
    const segmenter = await loadSegmenter().catch(() => null);
    while (!stopped) {
      if (!segmenter || !source.videoWidth || !source.videoHeight) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      const mask = await segmentFrame(segmenter, source, {
        infer: inferCanvas,
        inferCtx,
        rawMask: rawMaskCanvas,
        rawMaskCtx,
        featheredMask: featheredMaskCanvas,
        featheredMaskCtx,
      });
      if (mask) lastMask = mask;
    }
  }

  inferLoop();

  return {
    getMask: () => lastMask,
    stop() {
      stopped = true;
    },
  };
}
