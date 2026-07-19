/**
 * The "Draw on screen" overlay's drawing surface — a transparent, fullscreen canvas
 * loaded into its own BrowserWindow (see electron/main/annotationWindow.ts), spanning
 * the whole virtual desktop. Not part of the normal <Layout> shell: this window has no
 * topbar/footer, just the canvas.
 *
 * Strokes/undo-redo history live entirely here, not in main — main only relays tool/color
 * selection and undo/redo/clear commands from RecordPage's embedded toolbar, and gets a
 * canUndo/canRedo boolean pair back to enable/disable its buttons (see
 * reportHistoryState below). Ctrl+Z/Ctrl+Y are also handled locally, straight against
 * this window's own state, for undoing mid-drawing without needing to alt-tab back to
 * the main app first (see the keydown listener below).
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { AnnotationStroke, AnnotationTool } from "@shared/types/annotation";

function drawStroke(ctx: CanvasRenderingContext2D, stroke: AnnotationStroke): void {
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (stroke.tool === "pen") {
    if (stroke.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const p of stroke.points.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    return;
  }

  const [start, end] = stroke.points;
  if (!start || !end) return;

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
  } else if (stroke.tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const headLen = 16;
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - headLen * Math.cos(angle - Math.PI / 6), end.y - headLen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(end.x - headLen * Math.cos(angle + Math.PI / 6), end.y - headLen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
  }
}

export function AnnotationDrawPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<AnnotationTool>("pointer");
  const [color, setColor] = useState<string>("#e63946");
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
  const [redoStack, setRedoStack] = useState<AnnotationStroke[]>([]);
  const [current, setCurrent] = useState<AnnotationStroke | null>(null);

  // A real BrowserWindow, not a div in the main app — its own document, so this doesn't
  // touch the main window's background.
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
    const unsubState = window.api.annotation.onStateChanged((state) => {
      setTool(state.tool);
      setColor(state.color);
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

  // Undo/redo straight from this window when it has focus (e.g. mid-drawing), not just
  // via the main app's toolbar — also reports back through the same reportHistoryState
  // path so the toolbar's buttons stay in sync either way. Escape drops back to
  // "pointer" (click-through) so the user can get back to whatever's underneath without
  // alt-tabbing to Doculigent — it does NOT close the overlay itself, which stays open
  // (strokes, toolbar, everything) until explicitly closed.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (tool !== "pointer") window.api.annotation.setTool("pointer").catch(() => {});
        return;
      }
      if (!e.ctrlKey) return;
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

  // Lets the toolbar's undo/redo buttons reflect whether there's anything to undo/redo.
  useEffect(() => {
    window.api.annotation.reportHistoryState(strokes.length > 0, redoStack.length > 0).catch(() => {});
  }, [strokes, redoStack]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of strokes) drawStroke(ctx, s);
    if (current) drawStroke(ctx, current);
  }, [strokes, current]);

  function handleMouseDown(e: ReactMouseEvent<HTMLCanvasElement>): void {
    if (tool === "pointer") return;
    const point = { x: e.clientX, y: e.clientY };
    setCurrent({ id: crypto.randomUUID(), tool, color, points: tool === "pen" ? [point] : [point, point] });
  }

  function handleMouseMove(e: ReactMouseEvent<HTMLCanvasElement>): void {
    if (!current) return;
    const point = { x: e.clientX, y: e.clientY };
    setCurrent((prev) => {
      if (!prev) return prev;
      return prev.tool === "pen" ? { ...prev, points: [...prev.points, point] } : { ...prev, points: [prev.points[0], point] };
    });
  }

  function handleMouseUp(): void {
    if (!current) return;
    setStrokes((prev) => [...prev, current]);
    setRedoStack([]); // a fresh stroke invalidates whatever could have been redone
    setCurrent(null);
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
      onMouseUp={handleMouseUp}
    />
  );
}
