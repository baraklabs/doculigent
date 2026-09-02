import { Square, Circle, RectangleHorizontal, RectangleVertical, EyeOff, Eye, type LucideIcon } from "lucide-react";
import {
  DEFAULT_CAMERA_EDIT_SETTINGS,
  type CameraBlurLevel,
  type CameraEditSettings,
  type CameraEditShape,
  type EditProjectMedia,
} from "@shared/types/models";
import { ResetRow } from "./ResetRow";
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
}

export function CameraEditPanel({
  media,
  mediaLoading,
  camera,
  originalCamera,
  onChange,
  onResetAllToOriginal,
  onResetAllToDefault,
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
