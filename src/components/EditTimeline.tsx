import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CutRange } from "@shared/types/models";
import { mergeCuts } from "../lib/editRanges";
import "./EditTimeline.css";

interface EditTimelineProps {
  duration: number;
  currentTime: number;
  trimStart: number;
  trimEnd: number;
  cuts: CutRange[];
  onTrimStartChange: (value: number) => void;
  onTrimEndChange: (value: number) => void;
  onCutsChange: (cuts: CutRange[]) => void;
  onSeek: (value: number) => void;
}

type DragTarget =
  | { kind: "trimStart" }
  | { kind: "trimEnd" }
  | { kind: "cutStart"; index: number }
  | { kind: "cutEnd"; index: number }
  | { kind: "cutMove"; index: number }
  | { kind: "newCut" }
  | { kind: "playhead" }
  | null;

interface DragState {
  target: DragTarget;
  startTime: number;
  cutsAtDragStart: CutRange[];
}

const MIN_CUT_LENGTH = 0.15;

function formatTimecode(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

function pct(value: number, duration: number): string {
  return `${duration > 0 ? (value / duration) * 100 : 0}%`;
}

function neighborBounds(cuts: CutRange[], index: number, trimStart: number, trimEnd: number): [number, number] {
  const lower = index > 0 ? cuts[index - 1].end : trimStart;
  const upper = index < cuts.length - 1 ? cuts[index + 1].start : trimEnd;
  return [lower, upper];
}

export function EditTimeline({
  duration,
  currentTime,
  trimStart,
  trimEnd,
  cuts,
  onTrimStartChange,
  onTrimEndChange,
  onCutsChange,
  onSeek,
}: EditTimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [toolMode, setToolMode] = useState<"select" | "scissors">("select");
  const [draftCut, setDraftCut] = useState<CutRange | null>(null);
  const dragRef = useRef<DragState>({ target: null, startTime: 0, cutsAtDragStart: [] });

  function timeFromClientX(clientX: number): number {
    const rect = trackRef.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  function beginDrag(target: DragTarget) {
    return (e: ReactPointerEvent) => {
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      dragRef.current = { target, startTime: timeFromClientX(e.clientX), cutsAtDragStart: cuts };
    };
  }

  function handleTrackPointerDown(e: ReactPointerEvent) {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const t = timeFromClientX(e.clientX);
    if (toolMode === "scissors") {
      const clamped = Math.min(Math.max(t, trimStart), trimEnd);
      setDraftCut({ start: clamped, end: clamped });
      dragRef.current = { target: { kind: "newCut" }, startTime: clamped, cutsAtDragStart: cuts };
    } else {
      dragRef.current = { target: { kind: "playhead" }, startTime: t, cutsAtDragStart: cuts };
      onSeek(t);
    }
  }

  function handlePointerMove(e: ReactPointerEvent) {
    const drag = dragRef.current;
    if (!drag.target) return;
    const t = timeFromClientX(e.clientX);

    switch (drag.target.kind) {
      case "trimStart":
        onTrimStartChange(Math.min(t, trimEnd - 0.1));
        break;
      case "trimEnd":
        onTrimEndChange(Math.max(t, trimStart + 0.1));
        break;
      case "cutStart": {
        const { index } = drag.target;
        const [lower] = neighborBounds(cuts, index, trimStart, trimEnd);
        const newStart = Math.max(lower, Math.min(t, cuts[index].end - 0.1));
        onCutsChange(cuts.map((c, i) => (i === index ? { ...c, start: newStart } : c)));
        break;
      }
      case "cutEnd": {
        const { index } = drag.target;
        const [, upper] = neighborBounds(cuts, index, trimStart, trimEnd);
        const newEnd = Math.min(upper, Math.max(t, cuts[index].start + 0.1));
        onCutsChange(cuts.map((c, i) => (i === index ? { ...c, end: newEnd } : c)));
        break;
      }
      case "cutMove": {
        const { index } = drag.target;
        const original = drag.cutsAtDragStart[index];
        const length = original.end - original.start;
        const [lower, upper] = neighborBounds(drag.cutsAtDragStart, index, trimStart, trimEnd);
        const delta = t - drag.startTime;
        const newStart = Math.min(Math.max(original.start + delta, lower), upper - length);
        onCutsChange(cuts.map((c, i) => (i === index ? { start: newStart, end: newStart + length } : c)));
        break;
      }
      case "newCut": {
        const clamped = Math.min(Math.max(t, trimStart), trimEnd);
        setDraftCut({ start: Math.min(drag.startTime, clamped), end: Math.max(drag.startTime, clamped) });
        break;
      }
      case "playhead":
        onSeek(t);
        break;
    }
  }

  function endDrag() {
    const drag = dragRef.current;
    if (drag.target?.kind === "newCut" && draftCut && draftCut.end - draftCut.start > MIN_CUT_LENGTH) {
      onCutsChange(mergeCuts([...cuts, draftCut], trimStart, trimEnd));
    }
    setDraftCut(null);
    dragRef.current = { target: null, startTime: 0, cutsAtDragStart: [] };
  }

  function deleteCut(index: number) {
    onCutsChange(cuts.filter((_, i) => i !== index));
  }

  return (
    <div className="edit-timeline-wrap">
      <div className="edit-timeline-header">
        <span className="edit-timeline-times">
          {formatTimecode(currentTime)} <span className="muted">/ {formatTimecode(duration)}</span>
        </span>
        <div className="edit-timeline-toolbar">
          <button
            type="button"
            className={toolMode === "select" ? "timeline-tool active" : "timeline-tool"}
            onClick={() => setToolMode("select")}
            title="Select / scrub"
          >
            ↔ Select
          </button>
          <button
            type="button"
            className={toolMode === "scissors" ? "timeline-tool active" : "timeline-tool"}
            onClick={() => setToolMode("scissors")}
            title="Drag on the timeline to cut out a section"
          >
            ✂ Cut
          </button>
        </div>
      </div>

      <div
        className={toolMode === "scissors" ? "edit-timeline scissors-mode" : "edit-timeline"}
        ref={trackRef}
        onPointerDown={handleTrackPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="edit-timeline-dimmed" style={{ left: 0, width: pct(trimStart, duration) }} />
        <div className="edit-timeline-dimmed" style={{ left: pct(trimEnd, duration), right: 0, width: "auto" }} />

        {cuts.map((cut, index) => (
          <div
            key={index}
            className="edit-timeline-cut"
            style={{ left: pct(cut.start, duration), width: pct(cut.end - cut.start, duration) }}
            onPointerDown={beginDrag({ kind: "cutMove", index })}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="edit-timeline-cut-label">{formatTimecode(cut.end - cut.start)}</span>
            <button
              type="button"
              className="edit-timeline-cut-delete"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                deleteCut(index);
              }}
              title="Remove this cut"
            >
              ✕
            </button>
            <div
              className="edit-timeline-handle cut-handle"
              onPointerDown={beginDrag({ kind: "cutStart", index })}
              onClick={(e) => e.stopPropagation()}
            />
            <div
              className="edit-timeline-handle cut-handle right"
              onPointerDown={beginDrag({ kind: "cutEnd", index })}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        ))}

        {draftCut && (
          <div
            className="edit-timeline-cut draft"
            style={{ left: pct(draftCut.start, duration), width: pct(draftCut.end - draftCut.start, duration) }}
          />
        )}

        <div
          className="edit-timeline-handle trim-handle"
          style={{ left: pct(trimStart, duration) }}
          onPointerDown={beginDrag({ kind: "trimStart" })}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="edit-timeline-handle-label">{formatTimecode(trimStart)}</span>
        </div>
        <div
          className="edit-timeline-handle trim-handle right"
          style={{ left: pct(trimEnd, duration) }}
          onPointerDown={beginDrag({ kind: "trimEnd" })}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="edit-timeline-handle-label">{formatTimecode(trimEnd)}</span>
        </div>

        <div className="edit-timeline-playhead" style={{ left: pct(currentTime, duration) }} />
      </div>
    </div>
  );
}
