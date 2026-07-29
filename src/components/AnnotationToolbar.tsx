
import { useEffect, useState, type ReactNode } from "react";
import { Pencil, ArrowRight, Circle, Square, Undo2, Redo2, Trash2 } from "lucide-react";
import {
  ANNOTATION_COLORS,
  ANNOTATION_FADE_OPTIONS,
  ANNOTATION_OPACITY_MAX,
  ANNOTATION_OPACITY_MIN,
  ANNOTATION_OPACITY_STEP,
  ANNOTATION_WIDTHS,
  type AnnotationTool,
} from "@shared/types/annotation";
import "./AnnotationToolbar.css";

/** The universal "none" symbol — this button isn't a tool, it's the absence of one. */
function NoToolIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.6 12.4L12.4 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** A plain diagonal stroke — the arrow tool's shaft with no head, so it reads as "arrow
 *  minus the point" rather than an unrelated new shape. */
function LineIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <line x1="2.5" y1="13.5" x2="13.5" y2="2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function fadeLabel(ms: number): string {
  return ms === 0 ? "Off" : `${ms / 1000}s`;
}

const TOOLS: { value: AnnotationTool; label: string; icon: ReactNode }[] = [
  { value: "pointer", label: "No tool — stop drawing, clicks pass through (Esc)", icon: <NoToolIcon /> },
  { value: "pen", label: "Pen", icon: <Pencil size={14} /> },
  { value: "line", label: "Line", icon: <LineIcon /> },
  { value: "arrow", label: "Arrow", icon: <ArrowRight size={14} /> },
  { value: "circle", label: "Circle", icon: <Circle size={14} /> },
  { value: "square", label: "Square", icon: <Square size={14} /> },
];

export function AnnotationToolbar() {
  const [tool, setToolState] = useState<AnnotationTool>("pointer");
  const [color, setColorState] = useState<string>(ANNOTATION_COLORS[0]);
  const [width, setWidthState] = useState<number>(ANNOTATION_WIDTHS[1]);
  const [opacity, setOpacityState] = useState<number>(ANNOTATION_OPACITY_MAX);
  const [fadeMs, setFadeMsState] = useState<number>(ANNOTATION_FADE_OPTIONS[0]);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    window.api.annotation.isOpen().then(setOverlayOpen).catch(() => {});
    const unsubOpen = window.api.annotation.onOverlayOpenChanged(setOverlayOpen);
    const unsubState = window.api.annotation.onStateChanged((state) => {
      setToolState(state.tool);
      setColorState(state.color);
      setWidthState(state.width);
      setOpacityState(state.opacity);
      setFadeMsState(state.fadeMs);
    });
    const unsubHistory = window.api.annotation.onHistoryStateChanged((state) => {
      setCanUndo(state.canUndo);
      setCanRedo(state.canRedo);
    });
    return () => {
      unsubOpen();
      unsubState();
      unsubHistory();
    };
  }, []);

  async function selectTool(next: AnnotationTool): Promise<void> {
    setToolState(next);
    if (!overlayOpen) await window.api.annotation.open();
    await window.api.annotation.setTool(next);
  }

  function selectColor(next: string): void {
    setColorState(next);
    window.api.annotation.setColor(next).catch(() => {});
  }

  function selectWidth(next: number): void {
    setWidthState(next);
    window.api.annotation.setWidth(next).catch(() => {});
  }

  function selectOpacity(next: number): void {
    setOpacityState(next);
    window.api.annotation.setOpacity(next).catch(() => {});
  }

  function selectFade(next: number): void {
    setFadeMsState(next);
    window.api.annotation.setFadeMs(next).catch(() => {});
  }

  const fadeIndex = Math.max(0, ANNOTATION_FADE_OPTIONS.indexOf(fadeMs as (typeof ANNOTATION_FADE_OPTIONS)[number]));

  useEffect(() => {
    if (!overlayOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (tool !== "pointer") {
          setToolState("pointer");
          window.api.annotation.setTool("pointer").catch(() => {});
        }
        return;
      }
      if (!e.ctrlKey) return;
      if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        window.api.annotation.undo().catch(() => {});
      } else if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        window.api.annotation.redo().catch(() => {});
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tool, overlayOpen]);

  // No heading of its own — the Record page's "Draw on screen" block already titles it.
  return (
    <div className="annotation-toolbar">
        <div className="annotation-toolbar-group">
          {TOOLS.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`annotation-toolbar-btn${tool === t.value ? " active" : ""}`}
              title={t.label}
              onClick={() => selectTool(t.value)}
            >
              {t.icon}
            </button>
          ))}
        </div>

        <div className="annotation-toolbar-group">
          {ANNOTATION_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`annotation-swatch${color === c ? " active" : ""}`}
              style={{ background: c }}
              title={c}
              onClick={() => selectColor(c)}
            />
          ))}
        </div>

        <div className="annotation-toolbar-group">
          {ANNOTATION_WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              className={`annotation-toolbar-btn${width === w ? " active" : ""}`}
              title={`${w}px stroke`}
              onClick={() => selectWidth(w)}
            >
              <span className="annotation-width-dot" style={{ width: Math.min(w + 3, 18), height: Math.min(w + 3, 18) }} />
            </button>
          ))}
        </div>

        <div className="annotation-toolbar-group annotation-slider-group">
          <span className="annotation-slider-label">Opacity</span>
          <input
            type="range"
            className="annotation-slider"
            min={ANNOTATION_OPACITY_MIN}
            max={ANNOTATION_OPACITY_MAX}
            step={ANNOTATION_OPACITY_STEP}
            value={opacity}
            title={`${Math.round(opacity * 100)}% opacity`}
            onChange={(e) => selectOpacity(Number(e.target.value))}
          />
          <span className="annotation-slider-value">{Math.round(opacity * 100)}%</span>
        </div>

        <div className="annotation-toolbar-group annotation-slider-group">
          <span className="annotation-slider-label">Fade</span>
          <input
            type="range"
            className="annotation-slider"
            min={0}
            max={ANNOTATION_FADE_OPTIONS.length - 1}
            step={1}
            value={fadeIndex}
            title="Auto-fade drawings"
            onChange={(e) => selectFade(ANNOTATION_FADE_OPTIONS[Number(e.target.value)])}
          />
          <span className="annotation-slider-value">{fadeLabel(fadeMs)}</span>
        </div>

        <div className="annotation-toolbar-group annotation-toolbar-group-last">
          <button
            type="button"
            className="annotation-toolbar-btn"
            title="Undo (Ctrl+Z)"
            disabled={!canUndo}
            onClick={() => window.api.annotation.undo().catch(() => {})}
          >
            <Undo2 size={14} />
          </button>
          <button
            type="button"
            className="annotation-toolbar-btn"
            title="Redo (Ctrl+Y)"
            disabled={!canRedo}
            onClick={() => window.api.annotation.redo().catch(() => {})}
          >
            <Redo2 size={14} />
          </button>
          <button
            type="button"
            className="annotation-toolbar-btn"
            title="Clear all"
            disabled={!overlayOpen}
            onClick={() => window.api.annotation.clear().catch(() => {})}
          >
            <Trash2 size={14} />
          </button>
        </div>
    </div>
  );
}
