import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Circle,
  Eraser,
  Eye,
  EyeOff,
  GripHorizontal,
  GripVertical,
  Pause,
  Pencil,
  Play,
  RectangleHorizontal,
  RectangleVertical,
  RotateCcw,
  Square as SquareIcon,
  Trash2,
} from "lucide-react";
import {
  ANNOTATION_COLORS,
  ANNOTATION_WIDTHS,
  type AnnotationTool,
} from "@shared/types/annotation";
import type {
  RecordingDockAction,
  RecordingDockBounds,
  RecordingDockConfig,
  RecordingDockOrientation,
} from "@shared/types/models";
import "./RecordingDockPage.css";

function NoToolIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.6 12.4L12.4 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function LineIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <line x1="2.5" y1="13.5" x2="13.5" y2="2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M2.5 13.5L13 3M13 3H6M13 3V10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const TOOLS: { value: AnnotationTool; label: string; icon: ReactNode }[] = [
  { value: "pointer", label: "No tool", icon: <NoToolIcon /> },
  { value: "pen", label: "Pen", icon: <Pencil size={14} /> },
  { value: "line", label: "Line", icon: <LineIcon /> },
  { value: "arrow", label: "Arrow", icon: <ArrowIcon /> },
  { value: "circle", label: "Circle", icon: <Circle size={14} /> },
  { value: "square", label: "Square", icon: <SquareIcon size={14} /> },
];

type Popover = "tool" | "color" | "width" | null;

const POPOVER_EXTRA = 168;

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function RecordingDockPage() {
  const [config, setConfig] = useState<RecordingDockConfig | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [paused, setPaused] = useState(false);
  const [started, setStarted] = useState(false);
  const [mainVisible, setMainVisible] = useState(true);
  const [popover, setPopover] = useState<Popover>(null);
  const collapsedBoundsRef = useRef<RecordingDockBounds | null>(null);

  const [tool, setToolState] = useState<AnnotationTool>("pointer");
  const [color, setColorState] = useState<string>(ANNOTATION_COLORS[0]);
  const [width, setWidthState] = useState<number>(ANNOTATION_WIDTHS[1]);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useEffect(() => {
    window.api.recordingDock.getConfig().then(setConfig);
    return window.api.recordingDock.onConfigChanged(setConfig);
  }, []);

  useEffect(
    () =>
      window.api.recordingDock.onTimerSync((sync) => {
        setElapsedMs(sync.elapsedMs);
        setPaused(sync.paused);
        setStarted(true);
      }),
    []
  );

  useEffect(() => {
    if (!started || paused) return;
    const id = setInterval(() => setElapsedMs((ms) => ms + 1000), 1000);
    return () => clearInterval(id);
  }, [started, paused]);

  useEffect(() => {
    window.api.recordingDock.isMainWindowVisible().then(setMainVisible);
    return window.api.recordingDock.onMainWindowVisibilityChanged(setMainVisible);
  }, []);

  useEffect(() => {
    window.api.annotation.getState().then((s) => {
      setToolState(s.tool);
      setColorState(s.color);
      setWidthState(s.width);
    });
    return window.api.annotation.onStateChanged((s) => {
      setToolState(s.tool);
      setColorState(s.color);
      setWidthState(s.width);
    });
  }, []);

  function handleGripPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startX = e.screenX;
    const startY = e.screenY;
    let startBounds: RecordingDockBounds | null = null;
    window.api.recordingDock.getBounds().then((b) => {
      startBounds = b;
    });

    function onMove(ev: PointerEvent): void {
      if (!startBounds) return;
      const next: RecordingDockBounds = {
        ...startBounds,
        x: startBounds.x + (ev.screenX - startX),
        y: startBounds.y + (ev.screenY - startY),
      };
      window.api.recordingDock.setBounds(next).catch(() => {});
    }
    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  async function togglePopover(which: Exclude<Popover, null>): Promise<void> {
    const opening = popover !== which;
    if (popover !== null) {
      setPopover(opening ? which : null);
      if (!opening) await collapse();
      return;
    }
    if (!opening) return;
    const current = await window.api.recordingDock.getBounds();
    if (!current || !config) return;
    collapsedBoundsRef.current = current;
    const expanded: RecordingDockBounds =
      config.orientation === "horizontal"
        ? { x: current.x, y: current.y - POPOVER_EXTRA, width: current.width, height: current.height + POPOVER_EXTRA }
        : { x: current.x - POPOVER_EXTRA, y: current.y, width: current.width + POPOVER_EXTRA, height: current.height };
    await window.api.recordingDock.setBounds(expanded);
    setPopover(which);
  }

  async function collapse(): Promise<void> {
    if (collapsedBoundsRef.current) {
      await window.api.recordingDock.setBounds(collapsedBoundsRef.current);
      collapsedBoundsRef.current = null;
    }
  }

  async function closePopover(): Promise<void> {
    if (popover === null) return;
    setPopover(null);
    await collapse();
  }

  async function selectTool(next: AnnotationTool): Promise<void> {
    setToolState(next);
    const isOpen = await window.api.annotation.isOpen();
    if (!isOpen) await window.api.annotation.open();
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

  async function toggleOrientation(): Promise<void> {
    if (!config) return;
    await closePopover();
    const next: RecordingDockOrientation = config.orientation === "horizontal" ? "vertical" : "horizontal";
    window.api.recordingDock.setOrientation(next).catch(() => {});
  }

  function toggleMainWindow(): void {
    if (mainVisible) window.api.recordingDock.hideMainWindow().catch(() => {});
    else window.api.recordingDock.showMainWindow().catch(() => {});
  }

  function sendAction(action: RecordingDockAction): void {
    window.api.recordingDock.sendAction(action).catch(() => {});
  }

  function handleDiscard(): void {
    if (!window.confirm("Discard this recording? Everything captured so far will be permanently deleted.")) return;
    sendAction("discard");
  }

  if (!config) return null;

  return (
    <div className="recording-dock-root" data-orientation={config.orientation}>
      <div className="recording-dock-bar">
        <div
          className="recording-dock-grip"
          title="Drag to move"
          onPointerDown={handleGripPointerDown}
        >
          {config.orientation === "horizontal" ? <GripVertical size={14} /> : <GripHorizontal size={14} />}
        </div>

        <div className="recording-dock-timer">
          <span className={`recording-dock-timer-dot${paused ? " paused" : ""}`} aria-hidden="true" />
          {formatElapsed(elapsedMs)}
        </div>

        <button
          type="button"
          className="recording-dock-btn"
          title="Restart (discards this recording and starts over)"
          data-tooltip="Restart"
          onClick={() => sendAction("restart")}
        >
          <RotateCcw size={15} />
        </button>

        <button
          type="button"
          className="recording-dock-btn"
          title={paused ? "Resume" : "Pause"}
          data-tooltip={paused ? "Resume" : "Pause"}
          onClick={() => sendAction(paused ? "resume" : "pause")}
        >
          {paused ? <Play size={15} /> : <Pause size={15} />}
        </button>

        <button
          type="button"
          className="recording-dock-btn recording-dock-btn-stop"
          title="Stop recording"
          data-tooltip="Stop"
          onClick={() => sendAction("stop")}
        >
          <SquareIcon size={13} fill="currentColor" />
        </button>

        <button
          type="button"
          className="recording-dock-btn recording-dock-btn-danger"
          title="Discard recording (stops and deletes it without saving)"
          data-tooltip="Discard"
          onClick={handleDiscard}
        >
          <Trash2 size={15} />
        </button>

        <span className="recording-dock-divider" aria-hidden="true" />

        <div className="recording-dock-popover-anchor">
          <button
            type="button"
            className={`recording-dock-btn${tool !== "pointer" ? " active" : ""}${popover === "tool" ? " open" : ""}`}
            title="Annotation tool"
            data-tooltip="Draw"
            onClick={() => togglePopover("tool")}
          >
            <Pencil size={15} />
          </button>
          {popover === "tool" && (
            <div className="recording-dock-popover">
              {TOOLS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={`recording-dock-popover-btn${tool === t.value ? " active" : ""}`}
                  title={t.label}
                  onClick={() => selectTool(t.value)}
                >
                  {t.icon}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="recording-dock-popover-anchor">
          <button
            type="button"
            className={`recording-dock-btn${popover === "color" ? " open" : ""}`}
            title="Annotation color"
            data-tooltip="Color"
            onClick={() => togglePopover("color")}
          >
            <span className="recording-dock-color-swatch" style={{ background: color }} />
          </button>
          {popover === "color" && (
            <div className="recording-dock-popover">
              {ANNOTATION_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`recording-dock-swatch-btn${color === c ? " active" : ""}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => selectColor(c)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="recording-dock-popover-anchor">
          <button
            type="button"
            className={`recording-dock-btn${popover === "width" ? " open" : ""}`}
            title="Annotation stroke width"
            data-tooltip="Width"
            onClick={() => togglePopover("width")}
          >
            <span className="recording-dock-width-dot" style={{ width: Math.min(width + 3, 16), height: Math.min(width + 3, 16) }} />
          </button>
          {popover === "width" && (
            <div className="recording-dock-popover">
              {ANNOTATION_WIDTHS.map((w) => (
                <button
                  key={w}
                  type="button"
                  className={`recording-dock-popover-btn${width === w ? " active" : ""}`}
                  title={`${w}px stroke`}
                  onClick={() => selectWidth(w)}
                >
                  <span className="recording-dock-width-dot" style={{ width: Math.min(w + 3, 18), height: Math.min(w + 3, 18) }} />
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className="recording-dock-btn"
          title="Delete all annotations"
          data-tooltip="Erase"
          onClick={() => window.api.annotation.clear().catch(() => {})}
        >
          <Eraser size={15} />
        </button>

        <span className="recording-dock-divider" aria-hidden="true" />

        <button
          type="button"
          className="recording-dock-btn"
          title={config.orientation === "horizontal" ? "Switch to vertical dock" : "Switch to horizontal dock"}
          data-tooltip="Orientation"
          onClick={toggleOrientation}
        >
          {config.orientation === "horizontal" ? <RectangleVertical size={15} /> : <RectangleHorizontal size={15} />}
        </button>

        <button
          type="button"
          className={`recording-dock-btn${mainVisible ? " active" : ""}`}
          title={mainVisible ? "Hide the Doculigent app window" : "Show the Doculigent app window"}
          data-tooltip={mainVisible ? "Hide app" : "Show app"}
          onClick={toggleMainWindow}
        >
          {mainVisible ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>

        <div
          className="recording-dock-grip"
          title="Drag to move — this dock never appears in your recording"
          onPointerDown={handleGripPointerDown}
        >
          {config.orientation === "horizontal" ? <GripVertical size={14} /> : <GripHorizontal size={14} />}
        </div>
      </div>
    </div>
  );
}
