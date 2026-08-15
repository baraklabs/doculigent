
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpLeft,
  ArrowUpRight,
  Circle,
  RectangleHorizontal,
  RectangleVertical,
  Square,
  Squircle,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { CameraBubbleConfig, CameraBubbleShape } from "@shared/types/models";
import { applyCameraBlur, type CameraBlurHandle } from "../services/camera/cameraBlur";
import "./CameraBubblePage.css";

const MIN_SIZE = 80;
const MAX_SIZE = 640;
type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const HANDLE_SIZE = 14;
const HANDLE_OFFSET = 2;

const SHAPES: { value: CameraBubbleShape; label: string; Icon: typeof Circle }[] = [
  { value: "round", label: "Round", Icon: Circle },
  { value: "square", label: "Square", Icon: Square },
  { value: "rectangle", label: "Rectangle", Icon: RectangleHorizontal },
  { value: "rectangle-vertical", label: "Vertical rectangle", Icon: RectangleVertical },
];

type QuickPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "left-center" | "right-center";
const QUICK_POSITIONS: { value: QuickPosition; label: string; Icon: typeof ArrowUpLeft }[] = [
  { value: "top-left", label: "Snap to top-left", Icon: ArrowUpLeft },
  { value: "top-right", label: "Snap to top-right", Icon: ArrowUpRight },
  { value: "left-center", label: "Snap to left, centered", Icon: ArrowLeft },
  { value: "right-center", label: "Snap to right, centered", Icon: ArrowRight },
  { value: "bottom-left", label: "Snap to bottom-left", Icon: ArrowDownLeft },
  { value: "bottom-right", label: "Snap to bottom-right", Icon: ArrowDownRight },
];
const QUICK_POSITION_MARGIN = 16;

function roundedRectShapeRects(
  width: number,
  height: number,
  radius: number
): { x: number; y: number; width: number; height: number }[] {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r < 1) return [{ x: 0, y: 0, width: w, height: h }];

  const rects: { x: number; y: number; width: number; height: number }[] = [];
  let bandStartY = 0;
  let bandX0 = -1;
  let bandX1 = -1;
  const flush = (endY: number) => {
    if (bandX1 > bandX0) rects.push({ x: bandX0, y: bandStartY, width: bandX1 - bandX0, height: endY - bandStartY });
  };
  for (let y = 0; y < h; y++) {
    let dy = 0;
    if (y < r) dy = r - (y + 0.5);
    else if (y > h - r - 1) dy = y + 0.5 - (h - r);
    let inset = 0;
    if (dy > 0) {
      const clamped = Math.min(dy, r);
      inset = r - Math.sqrt(Math.max(0, r * r - clamped * clamped));
    }
    const x0 = Math.round(inset);
    const x1 = Math.round(w - inset);
    if (x0 === bandX0 && x1 === bandX1) continue;
    flush(y);
    bandStartY = y;
    bandX0 = x0;
    bandX1 = x1;
  }
  flush(h);
  return rects;
}

function shapeRegionFor(
  width: number,
  height: number,
  shape: CameraBubbleShape,
  roundedCorners: boolean,
  includeControls: boolean
) {
  const w = Math.round(width);
  const h = Math.round(height);
  const main =
    shape === "round"
      ? roundedRectShapeRects(w, h, Math.min(w, h) / 2)
      : roundedCorners
        ? roundedRectShapeRects(w, h, 20)
        : [{ x: 0, y: 0, width: w, height: h }];

  if (!includeControls) return main;

  const patches = [
    { x: HANDLE_OFFSET, y: HANDLE_OFFSET },
    { x: w - HANDLE_OFFSET - HANDLE_SIZE, y: HANDLE_OFFSET },
    { x: w - HANDLE_OFFSET - HANDLE_SIZE, y: h - HANDLE_OFFSET - HANDLE_SIZE },
    { x: HANDLE_OFFSET, y: h - HANDLE_OFFSET - HANDLE_SIZE },
  ].map(({ x, y }) => ({ x: Math.max(0, x), y: Math.max(0, y), width: HANDLE_SIZE, height: HANDLE_SIZE }));
  return [...main, ...patches];
}

const RECT_ASPECT = 1.6;
function sizeForShape(shape: CameraBubbleShape, width: number, height: number): { width: number; height: number } {
  const area = Math.max(MIN_SIZE * MIN_SIZE, width * height);
  if (shape === "rectangle") {
    const h = Math.max(MIN_SIZE, Math.round(Math.sqrt(area / RECT_ASPECT)));
    return { width: Math.max(MIN_SIZE, Math.round(h * RECT_ASPECT)), height: h };
  }
  if (shape === "rectangle-vertical") {
    const w = Math.max(MIN_SIZE, Math.round(Math.sqrt(area / RECT_ASPECT)));
    return { width: w, height: Math.max(MIN_SIZE, Math.round(w * RECT_ASPECT)) };
  }
  const side = Math.max(MIN_SIZE, Math.round(Math.sqrt(area)));
  return { width: side, height: side };
}

export function CameraBubblePage() {
  const [config, setConfig] = useState<CameraBubbleConfig | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const boundsRef = useRef({ x: 0, y: 0, width: 220, height: 220 });
  const [hovering, setHovering] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    return window.api.cameraBubble.onConfigChanged(setConfig);
  }, []);

  useEffect(() => {
    return window.api.cameraBubble.onRecordingActiveChanged(setRecordingActive);
  }, []);

  useEffect(() => {
    return window.api.cameraBubble.onHoverChanged(setHovering);
  }, []);

  const [boundsLoaded, setBoundsLoaded] = useState(false);
  useEffect(() => {
    window.api.cameraBubble.getBounds().then((b) => {
      if (b) boundsRef.current = b;
      setBoundsLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!config) return;
    let stream: MediaStream | null = null;
    let blurHandle: CameraBlurHandle | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: config.cameraDeviceId ? { deviceId: { exact: config.cameraDeviceId } } : true })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          if (config.blur === "none") {
            videoRef.current.srcObject = s;
          } else {
            blurHandle = applyCameraBlur(s, config.blur);
            videoRef.current.srcObject = blurHandle.stream;
          }
        }
        setCamError(null);
      })
      .catch((e) => setCamError(String(e)));
    return () => {
      cancelled = true;
      blurHandle?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [config?.cameraDeviceId, config?.blur]);

  useEffect(() => {
    if (!config || !boundsLoaded) return;
    const { width, height } = boundsRef.current;
    const rects = shapeRegionFor(width, height, config.shape, config.roundedCorners, hovering);
    window.api.cameraBubble.setShapeRegion(rects).catch(() => {});
  }, [config?.shape, config?.roundedCorners, boundsLoaded, hovering]);

  function handleDragPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.screenX;
    const startY = e.screenY;
    const startBounds = { ...boundsRef.current };

    function onMove(ev: PointerEvent) {
      const next = { ...startBounds, x: startBounds.x + (ev.screenX - startX), y: startBounds.y + (ev.screenY - startY) };
      boundsRef.current = next;
      window.api.cameraBubble.setBounds(next).catch(() => {});
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function handleResizePointerDown(e: ReactPointerEvent<HTMLDivElement>, corner: Corner) {
    e.stopPropagation();
    if (e.button !== 0 || !config || recordingActive) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.screenX;
    const startY = e.screenY;
    const startBounds = { ...boundsRef.current };
    const lockAspect = config.shape === "round" || config.shape === "square";
    const currentShape = config.shape;
    const currentRounded = config.roundedCorners;

    function onMove(ev: PointerEvent) {
      const dx = ev.screenX - startX;
      const dy = ev.screenY - startY;
      const growX = corner.endsWith("e") ? dx : -dx;
      const growY = corner.startsWith("s") ? dy : -dy;
      let width = Math.max(MIN_SIZE, startBounds.width + growX);
      let height = Math.max(MIN_SIZE, startBounds.height + growY);
      if (lockAspect) {
        const size = Math.max(width, height);
        width = size;
        height = size;
      }
      const x = corner.endsWith("w") ? startBounds.x + (startBounds.width - width) : startBounds.x;
      const y = corner.startsWith("n") ? startBounds.y + (startBounds.height - height) : startBounds.y;
      const next = { x, y, width, height };
      boundsRef.current = next;
      window.api.cameraBubble.setBounds(next).catch(() => {});
      window.api.cameraBubble
        .setShapeRegion(shapeRegionFor(width, height, currentShape, currentRounded, true))
        .catch(() => {});
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function setShape(partial: Pick<CameraBubbleConfig, "shape" | "roundedCorners">) {
    if (!config || recordingActive) return;
    const full = { ...partial, freeformResize: config.freeformResize };
    setConfig((prev) => (prev ? { ...prev, ...full } : prev));
    window.api.cameraBubble.setShape(full).catch(() => {});
  }

  function selectShape(shape: CameraBubbleShape) {
    if (!config || recordingActive) return;
    if (shape !== config.shape) {
      const current = boundsRef.current;
      const { width, height } = sizeForShape(shape, current.width, current.height);
      const next = {
        x: Math.round(current.x + (current.width - width) / 2),
        y: Math.round(current.y + (current.height - height) / 2),
        width,
        height,
      };
      boundsRef.current = next;
      window.api.cameraBubble.setBounds(next).catch(() => {});
    }
    setShape({ shape, roundedCorners: config.roundedCorners });
  }

  function resizeBy(factor: number) {
    if (!config || recordingActive) return;
    const current = boundsRef.current;
    const width = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(current.width * factor)));
    const height = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(current.height * factor)));
    const next = {
      x: Math.round(current.x + (current.width - width) / 2),
      y: Math.round(current.y + (current.height - height) / 2),
      width,
      height,
    };
    boundsRef.current = next;
    window.api.cameraBubble.setBounds(next).catch(() => {});
    window.api.cameraBubble
      .setShapeRegion(shapeRegionFor(width, height, config.shape, config.roundedCorners, hovering))
      .catch(() => {});
  }

  function moveToQuickPosition(position: QuickPosition) {
    const { width, height } = boundsRef.current;
    const screenWithAvailOrigin = window.screen as Screen & { availLeft?: number; availTop?: number };
    const screenX = screenWithAvailOrigin.availLeft ?? 0;
    const screenY = screenWithAvailOrigin.availTop ?? 0;
    const screenW = window.screen.availWidth || window.screen.width;
    const screenH = window.screen.availHeight || window.screen.height;

    const left = screenX + QUICK_POSITION_MARGIN;
    const right = screenX + screenW - width - QUICK_POSITION_MARGIN;
    const top = screenY + QUICK_POSITION_MARGIN;
    const bottom = screenY + screenH - height - QUICK_POSITION_MARGIN;
    const middleY = screenY + Math.round((screenH - height) / 2);

    const { x, y } = {
      "top-left": { x: left, y: top },
      "top-right": { x: right, y: top },
      "bottom-left": { x: left, y: bottom },
      "bottom-right": { x: right, y: bottom },
      "left-center": { x: left, y: middleY },
      "right-center": { x: right, y: middleY },
    }[position];

    const next = { x: Math.round(x), y: Math.round(y), width, height };
    boundsRef.current = next;
    window.api.cameraBubble.setBounds(next).catch(() => {});
  }

  if (!config) return null;

  const shapeClass = config.shape === "round" ? "circle" : config.roundedCorners ? "rounded" : "sharp";

  return (
    <div className="camera-bubble-root" data-hovering={hovering}>
      <div className={`camera-bubble-shape camera-bubble-${shapeClass}`} onPointerDown={handleDragPointerDown}>
        {camError ? (
          <div className="camera-bubble-error">Camera unavailable</div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            style={config.mirror ? undefined : { transform: "scaleX(-1)" }}
          />
        )}
      </div>
      {/* The toolbar (and, before, the close button) is a sibling of .camera-bubble-shape,
          not a child of it — that div's overflow: hidden + border-radius clips its
          *children* to the circle/rounded mask, which cut a corner-positioned close button
          off entirely for a round bubble. Centering everything here in the toolbar sidesteps
          that a different way: dead center is inside the visible region for any shape. */}
      <div className="camera-bubble-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        {SHAPES.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            className={`camera-bubble-toolbar-btn${config.shape === value ? " active" : ""}`}
            title={recordingActive ? "Locked while recording" : label}
            data-tooltip={recordingActive ? "Locked while recording" : label}
            disabled={recordingActive}
            onClick={() => selectShape(value)}
          >
            <Icon size={13} />
          </button>
        ))}
        <button
          type="button"
          className={`camera-bubble-toolbar-btn${config.roundedCorners ? " active" : ""}`}
          title={recordingActive ? "Locked while recording" : "Rounded corners"}
          data-tooltip={recordingActive ? "Locked while recording" : "Rounded corners"}
          disabled={config.shape === "round" || recordingActive}
          onClick={() => setShape({ shape: config.shape, roundedCorners: !config.roundedCorners })}
        >
          <Squircle size={13} />
        </button>
        {/* Proportional grow/shrink, keeping the current aspect ratio — the corner dots
            (below) do the same via drag, this is just the click version. */}
        <button
          type="button"
          className="camera-bubble-toolbar-btn"
          title={recordingActive ? "Locked while recording" : "Smaller"}
          data-tooltip={recordingActive ? "Locked while recording" : "Smaller"}
          disabled={recordingActive}
          onClick={() => resizeBy(0.9)}
        >
          <ZoomOut size={13} />
        </button>
        <button
          type="button"
          className="camera-bubble-toolbar-btn"
          title={recordingActive ? "Locked while recording" : "Bigger"}
          data-tooltip={recordingActive ? "Locked while recording" : "Bigger"}
          disabled={recordingActive}
          onClick={() => resizeBy(1.1)}
        >
          <ZoomIn size={13} />
        </button>
        <span className="camera-bubble-toolbar-divider" aria-hidden="true" />
        {QUICK_POSITIONS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            className="camera-bubble-toolbar-btn"
            title={label}
            data-tooltip={label}
            onClick={() => moveToQuickPosition(value)}
          >
            <Icon size={13} />
          </button>
        ))}
        <span className="camera-bubble-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="camera-bubble-toolbar-btn camera-bubble-toolbar-close"
          title={recordingActive ? "Locked while recording" : "Close"}
          data-tooltip={recordingActive ? "Locked while recording" : "Close"}
          aria-label="Close camera bubble"
          disabled={recordingActive}
          onClick={() => {
            if (recordingActive) return;
            window.api.cameraBubble.close();
          }}
        >
          <X size={13} />
        </button>
      </div>
      {/* Always available on hover now — resizing isn't gated behind a separate "free-form"
          toggle anymore, since the round/square-locks-1:1 vs. rectangles-resize-freely rule
          (see handleResizePointerDown's lockAspect) was already doing the real work. Hidden
          (not just inert) while recordingActive — handleResizePointerDown already no-ops,
          this just makes the lock visible instead of a handle that looks draggable but
          silently does nothing. */}
      {!recordingActive &&
        CORNERS.map((corner) => (
          <div
            key={corner}
            className={`camera-bubble-handle camera-bubble-handle-${corner}`}
            onPointerDown={(e) => handleResizePointerDown(e, corner)}
          />
        ))}
    </div>
  );
}
