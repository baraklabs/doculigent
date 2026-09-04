import { Square, Circle, RectangleHorizontal, RectangleVertical, EyeOff, Eye, Mic, MicOff, type LucideIcon } from "lucide-react";
import {
  BACKGROUND_GRADIENTS,
  DEFAULT_CAMERA_EDIT_SETTINGS,
  type CameraBlurLevel,
  type CameraEditSettings,
  type CameraEditShape,
  type EditProjectMedia,
} from "@shared/types/models";
import { CALLOUT_COLORS } from "@shared/lib/timelineEffects";
import { ResetRow } from "./ResetRow";
import { CutChipRail, type CutChipRailCut } from "./CutChipRail";
import "./CameraEditPanel.css";

const SHAPES: { id: CameraEditShape; label: string; icon: LucideIcon }[] = [
  { id: "square", label: "Square", icon: Square },
  { id: "round", label: "Round", icon: Circle },
  { id: "rectangle", label: "Horizontal", icon: RectangleHorizontal },
  { id: "rectangle-vertical", label: "Vertical", icon: RectangleVertical },
];

/** Rendered as one segmented control even though it's backed by two independent fields
 *  (blur/removeBackground) — "remove" takes over from blur entirely (see
 *  CameraEditSettings.removeBackground), so from the user's point of view there's really
 *  just one "what happens behind me" choice. */
type BackgroundMode = CameraBlurLevel | "remove";
const BACKGROUND_MODES: { id: BackgroundMode; label: string }[] = [
  { id: "none", label: "Show" },
  { id: "soft", label: "Soft blur" },
  { id: "aggressive", label: "Strong blur" },
  { id: "remove", label: "Remove" },
];

interface CameraEditPanelProps {
  media: EditProjectMedia | undefined;
  mediaLoading: boolean;
  camera: CameraEditSettings;
  /** What "Reset to original" restores — the recording's own camera bubble config
   *  when known, so it means "as recorded" rather than an arbitrary preset. */
  originalCamera: CameraEditSettings;
  onChange: (next: CameraEditSettings) => void;
  /** Global resets — same "original"/"default" distinction, applied across every tab. */
  onResetAllToOriginal: () => void;
  onResetAllToDefault: () => void;
  /** Master/Cut chip rail — `camera`/`onChange` above always mean "whatever's currently
   *  active" (master or a specific cut's override), routed by EditPage. */
  cuts: CutChipRailCut[];
  activeCutId: string;
  onActiveCutChange: (id: string) => void;
  onClearOverride?: () => void;
}

export function CameraEditPanel({
  media,
  mediaLoading,
  camera,
  originalCamera,
  onChange,
  onResetAllToOriginal,
  onResetAllToDefault,
  cuts,
  activeCutId,
  onActiveCutChange,
  onClearOverride,
}: CameraEditPanelProps) {
  function patch(partial: Partial<CameraEditSettings>) {
    onChange({ ...camera, ...partial });
  }

  if (mediaLoading) {
    return (
      <div className="camera-edit-empty">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!media?.editable) {
    return (
      <div className="camera-edit-empty">
        <p className="muted">
          {media?.singleFilePath
            ? "Camera editing isn't available for this recording — its camera wasn't captured as a separate track from the screen, so it can't be repositioned after the fact."
            : "This project has no linked recording with a camera to edit."}
        </p>
      </div>
    );
  }

  return (
    <div className="camera-edit-panel">
      <CutChipRail showMaster cuts={cuts} activeId={activeCutId} onSelect={onActiveCutChange} onClearOverride={onClearOverride} />

      <div className="camera-edit-row">
        <span className="camera-edit-label">Camera</span>
        <button
          type="button"
          className={`camera-edit-hide-btn${camera.hidden ? " on" : ""}`}
          aria-pressed={camera.hidden}
          onClick={() => patch({ hidden: !camera.hidden })}
        >
          {camera.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
          {camera.hidden ? "Hidden" : "Visible"}
        </button>
      </div>

      {/* The mic channel — the camera file's own audio track when there's a real camera,
          else (see EditProjectMedia.audioFilePath) a screen-only recording's separately-
          captured audio.wav, which has no Camera tab of its own to reach — this is still
          where its master + per-cut mute lives regardless, since a project in that shape
          never shows this tab with `media?.editable` false to begin with. Independent of
          the Visible/Hidden toggle above (and so outside the fieldset it disables) — hiding
          the bubble and muting its mic are two different things to want. */}
      <div className="camera-edit-row">
        <span className="camera-edit-label">Audio</span>
        <button
          type="button"
          className={`camera-edit-hide-btn${camera.muted ? " on" : ""}`}
          aria-pressed={camera.muted}
          onClick={() => patch({ muted: !camera.muted })}
        >
          {camera.muted ? <MicOff size={14} /> : <Mic size={14} />}
          {camera.muted ? "Muted" : "Unmuted"}
        </button>
      </div>

      <fieldset className="camera-edit-fieldset" disabled={camera.hidden}>
        <div className="camera-edit-section">
          <span className="camera-edit-label">Shape</span>
          <div className="camera-shape-grid">
            {SHAPES.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`camera-shape-tile${camera.shape === s.id ? " active" : ""}`}
                  aria-pressed={camera.shape === s.id}
                  onClick={() => patch({ shape: s.id })}
                >
                  <Icon size={22} />
                  <span>{s.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {camera.shape !== "round" && (
          <label className="camera-edit-slider-row">
            <span className="camera-edit-label">Roundness</span>
            <input
              type="range"
              min={0}
              max={50}
              value={camera.cornerRadiusPct}
              onChange={(e) => patch({ cornerRadiusPct: Number(e.target.value) })}
            />
            <span className="camera-edit-slider-value">{camera.cornerRadiusPct}%</span>
          </label>
        )}

        <label className="camera-edit-slider-row">
          <span className="camera-edit-label">Size</span>
          <input
            type="range"
            min={10}
            max={45}
            value={camera.sizePct}
            onChange={(e) => patch({ sizePct: Number(e.target.value) })}
          />
          <span className="camera-edit-slider-value">{camera.sizePct}%</span>
        </label>

        <label className="camera-edit-slider-row">
          <span className="camera-edit-label">Zoom</span>
          <input
            type="range"
            min={100}
            max={300}
            value={camera.zoomPct}
            onChange={(e) => patch({ zoomPct: Number(e.target.value) })}
          />
          <span className="camera-edit-slider-value">{camera.zoomPct}%</span>
        </label>

        <label className="camera-edit-slider-row">
          <span className="camera-edit-label">Crop top</span>
          <input
            type="range"
            min={0}
            max={45}
            value={camera.cropTopPct}
            onChange={(e) => patch({ cropTopPct: Number(e.target.value) })}
          />
          <span className="camera-edit-slider-value">{camera.cropTopPct}%</span>
        </label>
        <label className="camera-edit-slider-row">
          <span className="camera-edit-label">Crop right</span>
          <input
            type="range"
            min={0}
            max={45}
            value={camera.cropRightPct}
            onChange={(e) => patch({ cropRightPct: Number(e.target.value) })}
          />
          <span className="camera-edit-slider-value">{camera.cropRightPct}%</span>
        </label>
        <label className="camera-edit-slider-row">
          <span className="camera-edit-label">Crop bottom</span>
          <input
            type="range"
            min={0}
            max={45}
            value={camera.cropBottomPct}
            onChange={(e) => patch({ cropBottomPct: Number(e.target.value) })}
          />
          <span className="camera-edit-slider-value">{camera.cropBottomPct}%</span>
        </label>
        <label className="camera-edit-slider-row">
          <span className="camera-edit-label">Crop left</span>
          <input
            type="range"
            min={0}
            max={45}
            value={camera.cropLeftPct}
            onChange={(e) => patch({ cropLeftPct: Number(e.target.value) })}
          />
          <span className="camera-edit-slider-value">{camera.cropLeftPct}%</span>
        </label>

        <div className="camera-edit-section">
          <span className="camera-edit-label">Background</span>
          <div className="camera-blur-segmented">
            {BACKGROUND_MODES.map((b) => {
              const selected = camera.removeBackground ? "remove" : camera.blur;
              return (
                <button
                  key={b.id}
                  type="button"
                  className={`camera-blur-seg-btn${selected === b.id ? " active" : ""}`}
                  aria-pressed={selected === b.id}
                  onClick={() =>
                    b.id === "remove" ? patch({ removeBackground: true }) : patch({ removeBackground: false, blur: b.id })
                  }
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Border ringing the bubble's own outline — a plain stroke, or (once Marquee is
            turned on) an animated one, same Glow/Chase, solid-or-gradient choice as the
            Effects tab's own callout marquee, just applied to the camera shape instead of
            a callout box. */}
        <div className="camera-edit-section camera-border-section">
          <span className="camera-edit-label">Border</span>

          <label className="camera-edit-slider-row">
            <span className="camera-edit-label">Thickness</span>
            <input
              type="range"
              min={0}
              max={50}
              value={Math.round(camera.borderPct * 10)}
              onChange={(e) => patch({ borderPct: Number(e.target.value) / 10 })}
            />
            <span className="camera-edit-slider-value">{camera.borderPct.toFixed(1)}%</span>
          </label>

          <div className="camera-edit-row">
            <span className="camera-edit-label">Marquee</span>
            <div className="camera-blur-segmented">
              <button
                type="button"
                className={`camera-blur-seg-btn${!camera.marquee ? " active" : ""}`}
                aria-pressed={!camera.marquee}
                onClick={() => patch({ marquee: false })}
              >
                Off
              </button>
              <button
                type="button"
                className={`camera-blur-seg-btn${camera.marquee ? " active" : ""}`}
                aria-pressed={camera.marquee}
                onClick={() => patch({ marquee: true })}
              >
                On
              </button>
            </div>
          </div>

          {!camera.marquee && (
            <div className="camera-edit-row">
              <span className="camera-edit-label">Color</span>
              <div className="camera-swatches">
                {CALLOUT_COLORS.map((c) => (
                  <span key={c.id} className="camera-swatch-wrap">
                    <button
                      type="button"
                      className="camera-swatch"
                      style={{ background: c.color }}
                      title={c.label}
                      aria-label={c.label}
                      aria-pressed={camera.borderColor === c.color}
                      onClick={() => patch({ borderColor: c.color })}
                    />
                    {camera.borderColor === c.color && <span className="camera-swatch-dot" />}
                  </span>
                ))}
              </div>
            </div>
          )}

          {camera.marquee && (
            <>
              <div className="camera-edit-row">
                <span className="camera-edit-label">Style</span>
                <div className="camera-blur-segmented">
                  <button
                    type="button"
                    className={`camera-blur-seg-btn${camera.marqueeStyle === "glow" ? " active" : ""}`}
                    aria-pressed={camera.marqueeStyle === "glow"}
                    onClick={() => patch({ marqueeStyle: "glow" })}
                  >
                    Glow
                  </button>
                  <button
                    type="button"
                    className={`camera-blur-seg-btn${camera.marqueeStyle === "orbit" ? " active" : ""}`}
                    aria-pressed={camera.marqueeStyle === "orbit"}
                    onClick={() => patch({ marqueeStyle: "orbit" })}
                  >
                    Chase
                  </button>
                </div>
              </div>

              <div className="camera-edit-row">
                <span className="camera-edit-label">Color</span>
                <div className="camera-blur-segmented">
                  <button
                    type="button"
                    className={`camera-blur-seg-btn${camera.marqueeColorMode === "solid" ? " active" : ""}`}
                    aria-pressed={camera.marqueeColorMode === "solid"}
                    onClick={() => patch({ marqueeColorMode: "solid" })}
                  >
                    Solid
                  </button>
                  <button
                    type="button"
                    className={`camera-blur-seg-btn${camera.marqueeColorMode === "gradient" ? " active" : ""}`}
                    aria-pressed={camera.marqueeColorMode === "gradient"}
                    onClick={() => patch({ marqueeColorMode: "gradient" })}
                  >
                    Gradient
                  </button>
                </div>
              </div>

              {camera.marqueeColorMode === "solid" ? (
                <div className="camera-swatches camera-swatches-with-picker">
                  {CALLOUT_COLORS.map((c) => (
                    <span key={c.id} className="camera-swatch-wrap">
                      <button
                        type="button"
                        className="camera-swatch"
                        style={{ background: c.color }}
                        title={c.label}
                        aria-label={c.label}
                        aria-pressed={camera.marqueeColor === c.color}
                        onClick={() => patch({ marqueeColor: c.color })}
                      />
                      {camera.marqueeColor === c.color && <span className="camera-swatch-dot" />}
                    </span>
                  ))}
                  <span className="camera-swatch-wrap">
                    <label className="camera-swatch camera-swatch-custom" style={{ background: camera.marqueeColor }} title="Custom color">
                      <input
                        type="color"
                        aria-label="Custom marquee color"
                        value={camera.marqueeColor}
                        onChange={(e) => patch({ marqueeColor: e.target.value })}
                      />
                    </label>
                    {!CALLOUT_COLORS.some((c) => c.color === camera.marqueeColor) && <span className="camera-swatch-dot" />}
                  </span>
                </div>
              ) : (
                <div className="camera-swatches camera-swatches-with-picker">
                  {BACKGROUND_GRADIENTS.map((g) => {
                    const isActive = camera.marqueeGradientFrom === g.from && camera.marqueeGradientTo === g.to;
                    return (
                      <span key={g.id} className="camera-swatch-wrap">
                        <button
                          type="button"
                          className="camera-gradient-swatch"
                          style={{ background: `linear-gradient(${g.angleDeg}deg, ${g.from}, ${g.to})` }}
                          title={g.label}
                          aria-label={g.label}
                          aria-pressed={isActive}
                          onClick={() => patch({ marqueeGradientFrom: g.from, marqueeGradientTo: g.to })}
                        />
                        {isActive && <span className="camera-swatch-dot" />}
                      </span>
                    );
                  })}
                  <span className="camera-swatch-wrap">
                    <div
                      className="camera-gradient-swatch camera-gradient-swatch-custom"
                      style={{ background: `linear-gradient(135deg, ${camera.marqueeGradientFrom}, ${camera.marqueeGradientTo})` }}
                      title="Custom gradient"
                    >
                      <input
                        type="color"
                        title="From"
                        aria-label="Custom gradient — from color"
                        value={camera.marqueeGradientFrom}
                        onChange={(e) => patch({ marqueeGradientFrom: e.target.value })}
                      />
                      <input
                        type="color"
                        title="To"
                        aria-label="Custom gradient — to color"
                        value={camera.marqueeGradientTo}
                        onChange={(e) => patch({ marqueeGradientTo: e.target.value })}
                      />
                    </div>
                    {!BACKGROUND_GRADIENTS.some((g) => g.from === camera.marqueeGradientFrom && g.to === camera.marqueeGradientTo) && (
                      <span className="camera-swatch-dot" />
                    )}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </fieldset>

      <ResetRow
        onResetOriginal={() => onChange(originalCamera)}
        onResetDefault={() => onChange(DEFAULT_CAMERA_EDIT_SETTINGS)}
        onResetAllToOriginal={onResetAllToOriginal}
        onResetAllToDefault={onResetAllToDefault}
      />
    </div>
  );
}
