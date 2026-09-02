import { Box, Square, Trash2 } from "lucide-react";
import { ZOOM_PCT_PRESETS, type TimelineZoom, type TimelineZoomStyle } from "@shared/types/models";
import { CutChipRail, type CutChipRailCut } from "./CutChipRail";
import "./ZoomEditPanel.css";

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSecs = ms / 1000;
  const m = Math.floor(totalSecs / 60);
  const s = (totalSecs % 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}

const STYLES: { id: TimelineZoomStyle; label: string; icon: typeof Square }[] = [
  { id: "2d", label: "2D", icon: Square },
  { id: "3d", label: "3D", icon: Box },
];

interface ZoomEditPanelProps {
  zooms: TimelineZoom[];
  activeZoomId: string | null;
  onActiveZoomChange: (id: string) => void;
  onSetPct: (id: string, pct: number) => void;
  onSetStyle: (id: string, style: TimelineZoomStyle) => void;
  onRemove: (id: string) => void;
}

/** Replaces the zoom pct toolbar that used to float over a sole-selected block directly on
 *  the Timeline canvas — same 150/200/250/300% presets, now alongside a 2D/3D style toggle.
 *  The chip rail lists every zoom block already on the Timeline's Zoom track — there's no
 *  "Master" concept here (see CutChipRail's showMaster=false), each block is fully its own
 *  config. */
export function ZoomEditPanel({ zooms, activeZoomId, onActiveZoomChange, onSetPct, onSetStyle, onRemove }: ZoomEditPanelProps) {
  const cuts: CutChipRailCut[] = zooms.map((z, i) => ({ id: z.id, label: `Zoom ${i + 1}`, hasOverride: false }));
  const activeZoom = zooms.find((z) => z.id === activeZoomId) ?? null;

  return (
    <div className="zoom-edit-panel">
      <CutChipRail showMaster={false} cuts={cuts} activeId={activeZoomId ?? ""} onSelect={onActiveZoomChange} />

      {!activeZoom ? (
        <p className="zoom-edit-hint">
          Click the Zoom track below to add a zoom effect, or select an existing block to edit it here.
        </p>
      ) : (
        <>
          <div className="zoom-edit-time-range">
            {formatTime(activeZoom.startMs)} – {formatTime(activeZoom.startMs + activeZoom.durationMs)}
          </div>

          <div className="zoom-edit-section">
            <span className="zoom-edit-label">Zoom amount</span>
            <div className="zoom-pct-presets">
              {ZOOM_PCT_PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`zoom-pct-btn${activeZoom.pct === p ? " active" : ""}`}
                  onClick={() => onSetPct(activeZoom.id, p)}
                >
                  {p}%
                </button>
              ))}
            </div>
          </div>

          <div className="zoom-edit-section">
            <span className="zoom-edit-label">Style</span>
            <div className="zoom-style-segmented">
              {STYLES.map((s) => {
                const Icon = s.icon;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`zoom-style-seg-btn${activeZoom.style === s.id ? " active" : ""}`}
                    aria-pressed={activeZoom.style === s.id}
                    onClick={() => onSetStyle(activeZoom.id, s.id)}
                  >
                    <Icon size={14} />
                    {s.label}
                  </button>
                );
              })}
            </div>
            {/* 3D is data-only for now — both styles render the same flat zoom until a
                later pass adds the real perspective effect; the choice still saves. */}
            <p className="zoom-style-note">
              {activeZoom.style === "3d" ? "3D rendering is coming soon" : ""}
            </p>
          </div>

          <button type="button" className="zoom-edit-remove-btn" onClick={() => onRemove(activeZoom.id)}>
            <Trash2 size={13} />
            Remove this zoom
          </button>
        </>
      )}
    </div>
  );
}
