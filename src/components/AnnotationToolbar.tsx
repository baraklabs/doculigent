
import { Fragment, useEffect, useState } from "react";
import { ANNOTATION_COLORS, type AnnotationTool } from "@shared/types/annotation";

const TOOLS: { value: AnnotationTool; label: string; icon: string }[] = [
  { value: "pointer", label: "Off (click through)", icon: "↖" },
  { value: "pen", label: "Pen", icon: "✏️" },
  { value: "circle", label: "Circle", icon: "⭕" },
  { value: "square", label: "Square", icon: "⬜" },
  { value: "arrow", label: "Arrow", icon: "➡️" },
];

export function AnnotationToolbar() {
  const [tool, setToolState] = useState<AnnotationTool>("pointer");
  const [color, setColorState] = useState<string>(ANNOTATION_COLORS[0]);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    window.api.annotation.isOpen().then(setOverlayOpen).catch(() => {});
    const unsubOpen = window.api.annotation.onOverlayOpenChanged(setOverlayOpen);
    const unsubState = window.api.annotation.onStateChanged((state) => {
      setToolState(state.tool);
      setColorState(state.color);
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

  return (
    <Fragment>
      <span className="muted annotation-toolbar-label">Draw on screen</span>
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

        <div className="annotation-toolbar-group annotation-toolbar-group-last">
          <button
            type="button"
            className="annotation-toolbar-btn"
            title="Undo (Ctrl+Z)"
            disabled={!canUndo}
            onClick={() => window.api.annotation.undo().catch(() => {})}
          >
            ↶
          </button>
          <button
            type="button"
            className="annotation-toolbar-btn"
            title="Redo (Ctrl+Y)"
            disabled={!canRedo}
            onClick={() => window.api.annotation.redo().catch(() => {})}
          >
            ↷
          </button>
          <button
            type="button"
            className="annotation-toolbar-btn"
            title="Clear all"
            disabled={!overlayOpen}
            onClick={() => window.api.annotation.clear().catch(() => {})}
          >
            🗑️
          </button>
        </div>
      </div>
    </Fragment>
  );
}
