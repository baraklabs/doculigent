import { Box, Square, Trash2 } from "lucide-react";
import { ZOOM_PCT_PRESETS, type TimelineZoom, type TimelineZoomStyle, type TimelineZoomTilt } from "@shared/types/models";
import { TILT_CUSTOM_ANGLE_LIMIT_DEG, TILT_DIRECTION_PRESETS } from "@shared/lib/timelineZooms";
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

interface TiltSliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onReset: () => void;
}

/** One "label / Reset link + value / slider" row, for the Custom section's Tilt X/Tilt Y
 *  sliders — label top-left, a "Reset" link plus the current value top-right, full-width
 *  slider below. Reset always goes to 0, the neutral value on both axes. */
function TiltSliderRow({ label, value, min, max, onChange, onReset }: TiltSliderRowProps) {
  return (
    <div className="tilt-slider-row">
      <div className="tilt-slider-header">
        <span className="tilt-slider-label">{label}</span>
        <div className="tilt-slider-header-right">
          <button type="button" className="tilt-slider-reset" onClick={onReset} disabled={value === 0}>
            Reset
          </button>
          <span className="tilt-slider-value">{Math.round(value)}</span>
        </div>
      </div>
      <input
        type="range"
        className="tilt-slider-input"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

interface ZoomEditPanelProps {
  zooms: TimelineZoom[];
  activeZoomId: string | null;
  onActiveZoomChange: (id: string) => void;
  onSetPct: (id: string, pct: number) => void;
  onSetStyle: (id: string, style: TimelineZoomStyle) => void;
  onSetTilt: (id: string, patch: Partial<TimelineZoomTilt>) => void;
  onRemove: (id: string) => void;
}

/** Replaces the zoom pct toolbar that used to float over a sole-selected block directly on
 *  the Timeline canvas — same 150/200/250/300% presets, now alongside a 2D/3D style toggle.
 *  The chip rail lists every zoom block already on the Timeline's Zoom track — there's no
 *  "Master" concept here (see CutChipRail's showMaster=false), each block is fully its own
 *  config. */
export function ZoomEditPanel({ zooms, activeZoomId, onActiveZoomChange, onSetPct, onSetStyle, onSetTilt, onRemove }: ZoomEditPanelProps) {
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
          </div>

          {activeZoom.style === "3d" && (
            <div className="zoom-edit-section">
              <span className="zoom-edit-label">Tilt</span>
              <div className="tilt-preset-grid">
                {TILT_DIRECTION_PRESETS.map((p) => {
                  const isActive = activeZoom.tilt.xDeg === p.xDeg && activeZoom.tilt.yDeg === p.yDeg;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`tilt-preset-btn${isActive ? " active" : ""}`}
                      title={p.label}
                      aria-label={p.label}
                      aria-pressed={isActive}
                      onClick={() => onSetTilt(activeZoom.id, { xDeg: p.xDeg, yDeg: p.yDeg })}
                    >
                      <span
                        className="tilt-preset-swatch"
                        style={{ transform: `perspective(60px) rotateX(${p.xDeg}deg) rotateY(${p.yDeg}deg)` }}
                      />
                    </button>
                  );
                })}
              </div>

              <span className="tilt-custom-label">Custom</span>
              <div className="tilt-custom-sliders">
                <TiltSliderRow
                  label="Tilt X"
                  value={activeZoom.tilt.xDeg}
                  min={-TILT_CUSTOM_ANGLE_LIMIT_DEG}
                  max={TILT_CUSTOM_ANGLE_LIMIT_DEG}
                  onChange={(v) => onSetTilt(activeZoom.id, { xDeg: v })}
                  onReset={() => onSetTilt(activeZoom.id, { xDeg: 0 })}
                />
                <TiltSliderRow
                  label="Tilt Y"
                  value={activeZoom.tilt.yDeg}
                  min={-TILT_CUSTOM_ANGLE_LIMIT_DEG}
                  max={TILT_CUSTOM_ANGLE_LIMIT_DEG}
                  onChange={(v) => onSetTilt(activeZoom.id, { yDeg: v })}
                  onReset={() => onSetTilt(activeZoom.id, { yDeg: 0 })}
                />
              </div>
            </div>
          )}

          <button type="button" className="zoom-edit-remove-btn" onClick={() => onRemove(activeZoom.id)}>
            <Trash2 size={13} />
            Remove this zoom
          </button>
        </>
      )}
    </div>
  );
}
