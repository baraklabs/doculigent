import {
  MousePointer,
  MousePointer2,
  Circle,
  Pointer,
  Crosshair,
  Mouse,
  Sparkles,
  Volume2,
  PaintBucket,
  type LucideIcon,
} from "lucide-react";
import {
  DEFAULT_CURSOR_EDIT_SETTINGS,
  ORIGINAL_CURSOR_EDIT_SETTINGS,
  type ClickAnimationStyle,
  type ClickSoundStyle,
  type CursorEditSettings,
  type CursorStyle,
} from "@shared/types/models";
import { ResetRow } from "./ResetRow";
import "./CursorEditPanel.css";

const STYLES: { id: CursorStyle; label: string; icon: LucideIcon }[] = [
  { id: "default", label: "Default", icon: MousePointer },
  { id: "arrow", label: "Arrow", icon: MousePointer2 },
  { id: "mouse-pointer", label: "Pointer", icon: MousePointer },
  { id: "mouse-simple", label: "Mouse", icon: Mouse },
  { id: "circle", label: "Circle", icon: Circle },
  { id: "hand", label: "Hand", icon: Pointer },
  { id: "crosshair", label: "Crosshair", icon: Crosshair },
];

const COLOR_PRESETS = ["#ffffff", "#0d0f16", "#7c3aed", "#ef4444", "#3b82f6", "#22c55e", "#f59e0b"];

const ANIMATION_STYLES: { id: ClickAnimationStyle; label: string }[] = [
  { id: "ripple", label: "Ripple" },
  { id: "pulse", label: "Pulse" },
  { id: "burst", label: "Burst" },
];

const SOUND_STYLES: { id: ClickSoundStyle; label: string }[] = [
  { id: "tick", label: "Tick" },
  { id: "pop", label: "Pop" },
  { id: "click", label: "Click" },
];

interface CursorEditPanelProps {
  cursor: CursorEditSettings;
  onChange: (next: CursorEditSettings) => void;
  onResetAllToOriginal: () => void;
  onResetAllToDefault: () => void;
  /** True when this recording's screen video already has a real cursor baked into its
   *  pixels (see EditProjectMedia.cursorBakedIn) — none of the controls below have
   *  anything to draw on top of it, so a real one shows through unstyled regardless. */
  cursorBakedIn?: boolean;
}

export function CursorEditPanel({
  cursor,
  onChange,
  onResetAllToOriginal,
  onResetAllToDefault,
  cursorBakedIn,
}: CursorEditPanelProps) {
  function patch(partial: Partial<CursorEditSettings>) {
    onChange({ ...cursor, ...partial });
  }

  const tintable = cursor.style !== "default";

  return (
    <div className="cursor-edit-panel">
      {cursorBakedIn && (
        <div className="cursor-edit-baked-in-note">
          This recording's cursor can't be restyled — it was captured without a way to
          keep the real one out of the video, so it always shows through as-is.
        </div>
      )}
      <div className="cursor-edit-section">
        <span className="cursor-edit-label">Style</span>
        <div className="cursor-style-grid">
          {STYLES.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                className={`cursor-style-tile${cursor.style === s.id ? " active" : ""}`}
                aria-pressed={cursor.style === s.id}
                onClick={() => patch({ style: s.id })}
              >
                <Icon size={22} />
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <label className="cursor-edit-slider-row">
        <span className="cursor-edit-label">Size</span>
        <input
          type="range"
          min={50}
          max={500}
          step={5}
          value={cursor.sizePct}
          onChange={(e) => patch({ sizePct: Number(e.target.value) })}
        />
        <span className="cursor-edit-slider-value">{cursor.sizePct}%</span>
      </label>

      <div className={`cursor-edit-section${tintable ? "" : " disabled"}`}>
        <span className="cursor-edit-label">Color</span>
        <div className="cursor-color-row">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              className={`cursor-color-swatch${cursor.color === c ? " active" : ""}`}
              title={c}
              aria-label={c}
              aria-pressed={cursor.color === c}
              disabled={!tintable}
              style={{ background: c }}
              onClick={() => patch({ color: c })}
            />
          ))}
          <input
            type="color"
            className="cursor-color-custom"
            title="Custom color"
            aria-label="Custom color"
            disabled={!tintable}
            value={cursor.color}
            onChange={(e) => patch({ color: e.target.value })}
          />
        </div>
        <button
          type="button"
          className={`cursor-mini-toggle${cursor.filled ? " active" : ""}`}
          aria-pressed={cursor.filled}
          disabled={!tintable}
          onClick={() => patch({ filled: !cursor.filled })}
        >
          <PaintBucket size={13} />
          Color filled
          <span className="cursor-toggle-switch" data-on={cursor.filled} />
        </button>
      </div>

      <div className="cursor-edit-section">
        <span className="cursor-edit-label">Animation</span>
        <button
          type="button"
          className={`cursor-mini-toggle${cursor.clickEffect ? " active" : ""}`}
          aria-pressed={cursor.clickEffect}
          onClick={() => patch({ clickEffect: !cursor.clickEffect })}
        >
          <Sparkles size={13} />
          Click animation
          <span className="cursor-toggle-switch" data-on={cursor.clickEffect} />
        </button>
        {cursor.clickEffect && (
          <div className="cursor-style-segmented">
            {ANIMATION_STYLES.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`cursor-style-seg-btn${cursor.clickAnimationStyle === a.id ? " active" : ""}`}
                aria-pressed={cursor.clickAnimationStyle === a.id}
                onClick={() => patch({ clickAnimationStyle: a.id })}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="cursor-edit-section">
        <span className="cursor-edit-label">Sound</span>
        <button
          type="button"
          className={`cursor-mini-toggle${cursor.clickSound ? " active" : ""}`}
          aria-pressed={cursor.clickSound}
          onClick={() => patch({ clickSound: !cursor.clickSound })}
        >
          <Volume2 size={13} />
          Click sound
          <span className="cursor-toggle-switch" data-on={cursor.clickSound} />
        </button>
        {cursor.clickSound && (
          <div className="cursor-style-segmented">
            {SOUND_STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`cursor-style-seg-btn${cursor.clickSoundStyle === s.id ? " active" : ""}`}
                aria-pressed={cursor.clickSoundStyle === s.id}
                onClick={() => patch({ clickSoundStyle: s.id })}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <ResetRow
        onResetOriginal={() => onChange(ORIGINAL_CURSOR_EDIT_SETTINGS)}
        onResetDefault={() => onChange(DEFAULT_CURSOR_EDIT_SETTINGS)}
        onResetAllToOriginal={onResetAllToOriginal}
        onResetAllToDefault={onResetAllToDefault}
      />
    </div>
  );
}
