

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { AnnotationStroke, AnnotationTool } from "@shared/types/annotation";

function drawStroke(ctx: CanvasRenderingContext2D, stroke: AnnotationStroke, now: number): void {
  let alpha = stroke.opacity;
  if (stroke.fadeMs > 0) {
    const age = now - stroke.createdAt;
    if (age >= stroke.fadeMs) return; // fully expired — nothing to draw
    // Linear trail across the whole lifetime, not just a tail-end fade: full opacity the
    // instant it's drawn, gone by the time age reaches fadeMs.
    alpha *= 1 - age / stroke.fadeMs;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (stroke.tool === "pen") {
    if (stroke.points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (const p of stroke.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  } else {
    const [start, end] = stroke.points;
    if (start && end) {
      if (stroke.tool === "circle") {
        const cx = (start.x + end.x) / 2;
        const cy = (start.y + end.y) / 2;
        const rx = Math.max(Math.abs(end.x - start.x) / 2, 1);
        const ry = Math.max(Math.abs(end.y - start.y) / 2, 1);
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (stroke.tool === "square") {
        ctx.strokeRect(
          Math.min(start.x, end.x),
          Math.min(start.y, end.y),
          Math.abs(end.x - start.x),
          Math.abs(end.y - start.y)
        );
      } else if (stroke.tool === "line" || stroke.tool === "arrow") {
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();

        if (stroke.tool === "arrow") {
          const angle = Math.atan2(end.y - start.y, end.x - start.x);
          const headLen = 10 + stroke.width;
          ctx.beginPath();
          ctx.moveTo(end.x, end.y);
          ctx.lineTo(end.x - headLen * Math.cos(angle - Math.PI / 6), end.y - headLen * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(end.x, end.y);
          ctx.lineTo(end.x - headLen * Math.cos(angle + Math.PI / 6), end.y - headLen * Math.sin(angle + Math.PI / 6));
          ctx.stroke();
        }
      }
    }
  }
  ctx.restore();
}

export function AnnotationDrawPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<AnnotationTool>("pointer");
  const [color, setColor] = useState<string>("#e63946");
  const [width, setWidth] = useState<number>(4);
  const [opacity, setOpacity] = useState<number>(1);
  const [fadeMs, setFadeMs] = useState<number>(0);
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
  const [redoStack, setRedoStack] = useState<AnnotationStroke[]>([]);
  const [current, setCurrent] = useState<AnnotationStroke | null>(null);
  const [renderTick, setRenderTick] = useState(0);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }, []);

  function doUndo(): void {
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      setRedoStack((r) => [...r, prev[prev.length - 1]]);
      return prev.slice(0, -1);
    });
  }

  function doRedo(): void {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const stroke = prev[prev.length - 1];
      setStrokes((s) => [...s, stroke]);
      return prev.slice(0, -1);
    });
  }

  function doClear(): void {
    setStrokes([]);
    setRedoStack([]);
    setCurrent(null);
  }

  useEffect(() => {
    window.api.annotation
      .getState()
      .then((state) => {
        setTool(state.tool);
        setColor(state.color);
        setWidth(state.width);
        setOpacity(state.opacity);
        setFadeMs(state.fadeMs);
      })
      .catch(() => { });
    const unsubState = window.api.annotation.onStateChanged((state) => {
      setTool(state.tool);
      setColor(state.color);
      setWidth(state.width);
      setOpacity(state.opacity);
      setFadeMs(state.fadeMs);
    });
    const unsubCommand = window.api.annotation.onCommand((command) => {
      if (command === "undo") doUndo();
      else if (command === "redo") doRedo();
      else if (command === "clear") doClear();
    });
    return () => {
      unsubState();
      unsubCommand();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (tool !== "pointer") window.api.annotation.setTool("pointer").catch(() => { });
        return;
      }
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        doUndo();
      } else if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        doRedo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tool]);

  useEffect(() => {
    function finalizeCurrentStroke(): void {
      setCurrent((prev) => {
        if (!prev) return prev;
        setStrokes((s) => [...s, prev]);
        setRedoStack([]); // a fresh stroke invalidates whatever could have been redone
        window.api.annotation.setStrokeActive(false).catch(() => {});
        return null;
      });
    }
    document.addEventListener("mouseup", finalizeCurrentStroke);
    document.addEventListener("mouseleave", finalizeCurrentStroke);
    window.addEventListener("blur", finalizeCurrentStroke);
    return () => {
      document.removeEventListener("mouseup", finalizeCurrentStroke);
      document.removeEventListener("mouseleave", finalizeCurrentStroke);
      window.removeEventListener("blur", finalizeCurrentStroke);
    };
  }, []);

  // Lets the toolbar's undo/redo buttons reflect whether there's anything to undo/redo.
  useEffect(() => {
    window.api.annotation.reportHistoryState(strokes.length > 0, redoStack.length > 0).catch(() => { });
  }, [strokes, redoStack]);

  // Fading strokes need to keep repainting on their own timer, not just when a stroke is
  // added/removed — this keeps the canvas ticking at ~10fps for as long as any stroke on
  // it can still fade, and stops itself once none can.
  useEffect(() => {
    const hasFading = strokes.some((s) => s.fadeMs > 0);
    if (!hasFading) return;
    const id = setInterval(() => setRenderTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [strokes]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const now = Date.now();
    for (const s of strokes) drawStroke(ctx, s, now);
    if (current) drawStroke(ctx, current, now);
  }, [strokes, current, renderTick]);

  function handleMouseDown(e: ReactMouseEvent<HTMLCanvasElement>): void {
    if (tool === "pointer") return;
    const point = { x: e.clientX, y: e.clientY };

    setCurrent({
      id: crypto.randomUUID(),
      tool,
      color,
      width,
      opacity,
      fadeMs,
      createdAt: Date.now(),
      points: tool === "pen" ? [point] : [point, point],
    });
    window.api.annotation.setStrokeActive(true).catch(() => {});
  }

  function handleMouseMove(e: ReactMouseEvent<HTMLCanvasElement>): void {
    if (!current) return;
    const point = { x: e.clientX, y: e.clientY };
    setCurrent((prev) => {
      if (!prev) return prev;
      return prev.tool === "pen" ? { ...prev, points: [...prev.points, point] } : { ...prev, points: [prev.points[0], point] };
    });
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed",
        inset: 0,
        width: "100vw",
        height: "100vh",
        cursor: tool === "pointer" ? "default" : "crosshair",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
    />
  );
}
