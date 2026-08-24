
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

  const inferCanvas = document.createElement("canvas");
  const inferCtx = inferCanvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  const rawMaskCanvas = document.createElement("canvas");
  const rawMaskCtx = rawMaskCanvas.getContext("2d") as CanvasRenderingContext2D;
  const featheredMaskCanvas = document.createElement("canvas");
  const featheredMaskCtx = featheredMaskCanvas.getContext("2d") as CanvasRenderingContext2D;
  const personCanvas = document.createElement("canvas");
  const personCtx = personCanvas.getContext("2d") as CanvasRenderingContext2D;
  const outCanvas = document.createElement("canvas");
  const outCtx = outCanvas.getContext("2d") as CanvasRenderingContext2D;

  let stopped = false;
  let renderTimer: ReturnType<typeof setInterval> | null = null;
  let lastMask: HTMLCanvasElement | null = null;

  async function inferLoop(): Promise<void> {
    const segmenter = await loadSegmenter().catch(() => null);
    while (!stopped) {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!segmenter || !vw || !vh) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      const scale = INFER_SIZE / Math.max(vw, vh);
      const iw = Math.max(1, Math.round(vw * scale));
      const ih = Math.max(1, Math.round(vh * scale));
      if (inferCanvas.width !== iw || inferCanvas.height !== ih) {
        inferCanvas.width = iw;
        inferCanvas.height = ih;
      }
      inferCtx.drawImage(video, 0, 0, iw, ih);

      try {
        const [{ mask }] = await segmenter(RawImage.fromCanvas(inferCanvas));
        const { width: mw, height: mh, data } = mask;
        rawMaskCanvas.width = mw;
        rawMaskCanvas.height = mh;
        const imageData = rawMaskCtx.createImageData(mw, mh);
        for (let i = 0, j = 0; i < data.length; i++, j += 4) {
          imageData.data[j] = 255;
          imageData.data[j + 1] = 255;
          imageData.data[j + 2] = 255;
          imageData.data[j + 3] = data[i];
        }
        rawMaskCtx.putImageData(imageData, 0, 0);

        featheredMaskCanvas.width = mw;
        featheredMaskCanvas.height = mh;
        featheredMaskCtx.clearRect(0, 0, mw, mh);
        featheredMaskCtx.filter = `blur(${MASK_FEATHER_PX}px)`;
        featheredMaskCtx.drawImage(rawMaskCanvas, 0, 0);
        featheredMaskCtx.filter = "none";
        lastMask = featheredMaskCanvas;
      } catch {
        // Transient inference failure — keep compositing with the previous mask.
      }
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
  }

  inferLoop();
  // setInterval, NOT requestAnimationFrame — this loop feeds outCanvas.captureStream()
  // below, which during a recording is what RecordingService's own camera <video> element
  // (and from there its side-clip canvas/MediaRecorder) is reading from. The main window is
  // hidden for the whole duration of a recording, and rAF is driven by compositor frame
  // production, which a hidden window doesn't do — so this loop would stop while
  // captureStream kept emitting its last drawn frame, freezing the recorded camera video
  // while its audio (an entirely separate track) carried on. Same reasoning, and the same
  // fix, as RecordingService's tick()/sideTick(); see their comment for the full detail.
  renderLoop();
  renderTimer = setInterval(renderLoop, Math.round(1000 / OUTPUT_FPS));

  // Attached to the document (off-screen, invisible) rather than left fully detached — a
  // <video> that is never part of the rendered tree is a Chromium power-saving throttling
  // target in its own right, independent of the loop above.
  video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;";
  document.body.appendChild(video);

  const stream = outCanvas.captureStream(OUTPUT_FPS);
  return {
    stream,
    stop() {
      if (stopped) return;
      stopped = true;
      if (renderTimer !== null) clearInterval(renderTimer);
      renderTimer = null;
      video.pause();
      video.srcObject = null;
      video.remove();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
