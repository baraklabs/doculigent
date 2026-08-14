import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Check } from "lucide-react";
import { desktopConstraints } from "../services/recording/constraints";
import "./AreaSelectPage.css";

const RATIO_PRESETS: { label: string; ratio: number }[] = [
  { label: "3:4", ratio: 3 / 4 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "Square", ratio: 1 },
  { label: "16:9", ratio: 16 / 9 },
  { label: "9:16", ratio: 9 / 16 },
];

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Corner = "nw" | "ne" | "sw" | "se";
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const MIN_SIZE = 24;

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function reducedFraction(w: number, h: number): string {
  const divisor = (a: number, b: number): number => (b === 0 ? a : divisor(b, a % b));
  const g = divisor(Math.round(w), Math.round(h)) || 1;
  return `${Math.round(w / g)}:${Math.round(h / g)}`;
}

type DragState =
  | { mode: "create"; startClient: Point }
  | { mode: "move"; startClient: Point; startRect: Rect }
  | { mode: "resize"; corner: Corner; startClient: Point; startRect: Rect };

export function AreaSelectPage() {
  const [searchParams] = useSearchParams();
  const targetId = searchParams.get("targetId") ?? "";

  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    if (!targetId) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia(desktopConstraints(targetId))
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setVideoReady(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [targetId]);

  const [rect, setRect] = useState<Rect | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const activatedRef = useRef(false);

  function activateOnce(): void {
    if (activatedRef.current) return;
    activatedRef.current = true;
    window.api.areaSelect.activate().catch(() => {});
  }

  function cancel(): void {
    window.api.areaSelect.cancel().catch(() => {});
  }

  function confirm(): void {
    if (!rect) return;
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    window.api.areaSelect
      .complete(targetId, { x: rect.x / w, y: rect.y / h, width: rect.width / w, height: rect.height / h })
      .catch(() => {});
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
      else if (e.key === "Enter" && rect) confirm();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rect]);

  function handleRootPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    activateOnce();
    dragRef.current = { mode: "create", startClient: { x: e.clientX, y: e.clientY } };
    setRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 });
  }
  function handleRootPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d || d.mode !== "create") return;
    const x = Math.min(d.startClient.x, e.clientX);
    const y = Math.min(d.startClient.y, e.clientY);
    const width = Math.abs(e.clientX - d.startClient.x);
    const height = Math.abs(e.clientY - d.startClient.y);
    setRect({ x, y, width, height });
  }
  function handleRootPointerUp() {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (d.mode !== "create") return;
    setRect((prev) => (prev && (prev.width < 8 || prev.height < 8) ? null : prev));
  }

  function handleBoxPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !rect) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: "move", startClient: { x: e.clientX, y: e.clientY }, startRect: rect };
  }
  function handleBoxPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d || d.mode !== "move") return;
    const dx = e.clientX - d.startClient.x;
    const dy = e.clientY - d.startClient.y;
    const maxX = Math.max(0, window.innerWidth - d.startRect.width);
    const maxY = Math.max(0, window.innerHeight - d.startRect.height);
    setRect({ ...d.startRect, x: clamp(d.startRect.x + dx, 0, maxX), y: clamp(d.startRect.y + dy, 0, maxY) });
  }
  function handleBoxPointerUp() {
    if (dragRef.current?.mode === "move") dragRef.current = null;
  }

  function handleResizePointerDown(e: ReactPointerEvent<HTMLDivElement>, corner: Corner) {
    if (e.button !== 0 || !rect) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: "resize", corner, startClient: { x: e.clientX, y: e.clientY }, startRect: rect };
  }
  function handleResizePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d || d.mode !== "resize") return;
    const dx = e.clientX - d.startClient.x;
    const dy = e.clientY - d.startClient.y;
    let { x, y, width, height } = d.startRect;
    if (d.corner === "nw" || d.corner === "sw") {
      const newX = clamp(x + dx, 0, x + width - MIN_SIZE);
      width += x - newX;
      x = newX;
    } else {
      width = clamp(width + dx, MIN_SIZE, window.innerWidth - x);
    }
    if (d.corner === "nw" || d.corner === "ne") {
      const newY = clamp(y + dy, 0, y + height - MIN_SIZE);
      height += y - newY;
      y = newY;
    } else {
      height = clamp(height + dy, MIN_SIZE, window.innerHeight - y);
    }
    setRect({ x, y, width, height });
  }
  function handleResizePointerUp() {
    if (dragRef.current?.mode === "resize") dragRef.current = null;
  }

  function applyRatioPreset(ratio: number): void {
    activateOnce();
    const vw = window.innerWidth || 1920;
    const vh = window.innerHeight || 1080;
    let w = vw;
    let h = w / ratio;
    if (h > vh) {
      h = vh;
      w = h * ratio;
    }
    setRect({ x: (vw - w) / 2, y: (vh - h) / 2, width: w, height: h });
  }

  const ratioLabel = (() => {
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    const dpr = window.devicePixelRatio || 1;
    const pixelW = rect.width * dpr;
    const pixelH = rect.height * dpr;
    const ratio = pixelW / pixelH;
    const closest = RATIO_PRESETS.reduce((best, p) =>
      Math.abs(p.ratio - ratio) < Math.abs(best.ratio - ratio) ? p : best
    );
    const label = Math.abs(closest.ratio - ratio) / closest.ratio < 0.01 ? closest.label : reducedFraction(pixelW, pixelH);
    return `${Math.round(pixelW)} × ${Math.round(pixelH)} (${label})`;
  })();

  return (
    <div
      className="area-select-root"
      onPointerDown={handleRootPointerDown}
      onPointerMove={handleRootPointerMove}
      onPointerUp={handleRootPointerUp}
    >
      {videoReady && <video ref={videoRef} autoPlay muted playsInline className="area-select-video" />}
      {!rect && <div className="area-select-idle-dim" />}
      {rect && (
        <div
          className="area-select-box"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          onPointerDown={handleBoxPointerDown}
          onPointerMove={handleBoxPointerMove}
          onPointerUp={handleBoxPointerUp}
        >
          {ratioLabel && <span className="area-select-ratio-label">{ratioLabel}</span>}
          {CORNERS.map((corner) => (
            <div
              key={corner}
              className={`area-select-handle area-select-handle-${corner}`}
              onPointerDown={(e) => handleResizePointerDown(e, corner)}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerUp}
            />
          ))}
        </div>
      )}
      <div className="area-select-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        <span className="area-select-hint">
          {rect ? "Drag to move · corners to resize" : "Drag to select an area"} · Esc to cancel
        </span>
        <div className="area-select-presets">
          {RATIO_PRESETS.map((p) => (
            <button key={p.label} type="button" onClick={() => applyRatioPreset(p.ratio)}>
              {p.label}
            </button>
          ))}
        </div>
        {rect && (
          <button type="button" className="area-select-confirm" onClick={confirm}>
            <Check size={14} />
            Use area
          </button>
        )}
        <button type="button" className="area-select-cancel" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
