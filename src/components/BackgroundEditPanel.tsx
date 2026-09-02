import { useState } from "react";
import { Ban, Palette, Sparkles, Image as ImageIcon, Images, Upload, Loader2, Pipette, type LucideIcon } from "lucide-react";
import {
  BACKGROUND_COLORS,
  BACKGROUND_GRADIENTS,
  BACKGROUND_IMAGES,
  BACKGROUND_TEXTURES,
  DEFAULT_BACKGROUND_EDIT_SETTINGS,
  type BackgroundEditSettings,
  type BackgroundFill,
} from "@shared/types/models";
import { mediaUrl } from "@shared/constants/media";
import { BACKGROUND_IMAGE_URLS, BACKGROUND_TEXTURE_URLS } from "../assets/backgrounds";
import { EditProjectService } from "../services/editProjects/EditProjectService";
import { ResetRow } from "./ResetRow";
import "./BackgroundEditPanel.css";

const FILLS: { id: BackgroundFill; label: string; icon: LucideIcon }[] = [
  { id: "none", label: "None", icon: Ban },
  { id: "color", label: "Color", icon: Palette },
  { id: "gradient", label: "Gradient", icon: Sparkles },
  { id: "texture", label: "Texture", icon: ImageIcon },
  { id: "image", label: "Image", icon: Images },
];

interface BackgroundEditPanelProps {
  background: BackgroundEditSettings;
  onChange: (next: BackgroundEditSettings) => void;
  onResetAllToOriginal: () => void;
  onResetAllToDefault: () => void;
}

export function BackgroundEditPanel({
  background,
  onChange,
  onResetAllToOriginal,
  onResetAllToDefault,
}: BackgroundEditPanelProps) {
  const [importing, setImporting] = useState(false);
  function patch(partial: Partial<BackgroundEditSettings>) {
    onChange({ ...background, ...partial });
  }

  function patchCustomGradient(partial: Partial<{ from: string; to: string }>) {
    const base = background.customGradient ?? { from: BACKGROUND_GRADIENTS[0].from, to: BACKGROUND_GRADIENTS[0].to };
    patch({ customGradient: { ...base, ...partial } });
  }

  async function handleImportClick() {
    setImporting(true);
    try {
      const filePath = await EditProjectService.pickBackgroundImage();
      if (filePath) patch({ customImagePath: filePath });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="background-edit-panel">
      <div className="background-edit-section">
        <span className="background-edit-label">Backdrop</span>
        <div className="background-fill-grid">
          {FILLS.map((f) => {
            const Icon = f.icon;
            return (
              <button
                key={f.id}
                type="button"
                className={`background-fill-tile${background.fill === f.id ? " active" : ""}`}
                aria-pressed={background.fill === f.id}
                onClick={() => patch({ fill: f.id })}
              >
                <Icon size={20} />
                <span>{f.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {background.fill === "color" && (
        <div className="background-edit-section">
          <span className="background-edit-label">Color</span>
          <div className="background-swatch-grid">
            {BACKGROUND_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`background-swatch${!background.customColor && background.colorId === c.id ? " active" : ""}`}
                title={c.label}
                aria-label={c.label}
                aria-pressed={!background.customColor && background.colorId === c.id}
                style={{ background: c.color }}
                onClick={() => patch({ colorId: c.id, customColor: null })}
              />
            ))}
            <label
              className={`background-swatch background-swatch-custom${background.customColor ? " active" : ""}`}
              title="Custom color"
              aria-label="Custom color"
              style={background.customColor ? { background: background.customColor } : undefined}
            >
              {!background.customColor && <Pipette size={16} />}
              <input
                type="color"
                value={background.customColor ?? BACKGROUND_COLORS[0].color}
                onChange={(e) => patch({ customColor: e.target.value })}
              />
            </label>
          </div>
        </div>
      )}

      {background.fill === "gradient" && (
        <div className="background-edit-section">
          <span className="background-edit-label">Gradient</span>
          <div className="background-swatch-grid">
            {BACKGROUND_GRADIENTS.map((g) => (
              <button
                key={g.id}
                type="button"
                className={`background-swatch${!background.customGradient && background.gradientId === g.id ? " active" : ""}`}
                title={g.label}
                aria-label={g.label}
                aria-pressed={!background.customGradient && background.gradientId === g.id}
                style={{ background: `linear-gradient(${g.angleDeg}deg, ${g.from}, ${g.to})` }}
                onClick={() => patch({ gradientId: g.id, customGradient: null })}
              />
            ))}
            <div
              className={`background-swatch background-swatch-gradient-custom${background.customGradient ? " active" : ""}`}
              title="Custom gradient"
              style={{
                background: `linear-gradient(135deg, ${background.customGradient?.from ?? BACKGROUND_GRADIENTS[0].from}, ${background.customGradient?.to ?? BACKGROUND_GRADIENTS[0].to})`,
              }}
            >
              <input
                type="color"
                title="From"
                aria-label="Custom gradient — from color"
                value={background.customGradient?.from ?? BACKGROUND_GRADIENTS[0].from}
                onChange={(e) => patchCustomGradient({ from: e.target.value })}
              />
              <input
                type="color"
                title="To"
                aria-label="Custom gradient — to color"
                value={background.customGradient?.to ?? BACKGROUND_GRADIENTS[0].to}
                onChange={(e) => patchCustomGradient({ to: e.target.value })}
              />
            </div>
          </div>
        </div>
      )}

      {background.fill === "texture" && (
        <div className="background-edit-section">
          <span className="background-edit-label">Texture</span>
          <div className="background-swatch-grid">
            {BACKGROUND_TEXTURES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`background-swatch${background.textureId === t.id ? " active" : ""}`}
                title={t.label}
                aria-label={t.label}
                aria-pressed={background.textureId === t.id}
                style={{ backgroundImage: `url(${BACKGROUND_TEXTURE_URLS[t.id]})` }}
                onClick={() => patch({ textureId: t.id })}
              />
            ))}
          </div>
        </div>
      )}

      {background.fill === "image" && (
        <div className="background-edit-section">
          <span className="background-edit-label">Image</span>
          <div className="background-swatch-grid">
            <button
              type="button"
              className={`background-swatch background-swatch-import${background.customImagePath ? " active" : ""}`}
              title="Import from desktop"
              aria-label="Import from desktop"
              aria-pressed={!!background.customImagePath}
              disabled={importing}
              style={
                background.customImagePath
                  ? { backgroundImage: `url(${mediaUrl(background.customImagePath)})` }
                  : undefined
              }
              onClick={handleImportClick}
            >
              {!background.customImagePath &&
                (importing ? <Loader2 size={16} className="background-swatch-import-spin" /> : <Upload size={16} />)}
            </button>
            {BACKGROUND_IMAGES.map((img) => (
              <button
                key={img.id}
                type="button"
                className={`background-swatch${!background.customImagePath && background.imageId === img.id ? " active" : ""}`}
                title={img.label}
                aria-label={img.label}
                aria-pressed={!background.customImagePath && background.imageId === img.id}
                style={{ backgroundImage: `url(${BACKGROUND_IMAGE_URLS[img.id]})` }}
                onClick={() => patch({ imageId: img.id, customImagePath: null })}
              />
            ))}
          </div>
        </div>
      )}

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Padding</span>
        <input
          type="range"
          min={0}
          max={20}
          value={background.paddingPct}
          onChange={(e) => patch({ paddingPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{background.paddingPct}%</span>
      </label>

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Rounded corner</span>
        <input
          type="range"
          min={0}
          max={20}
          value={background.cornerRadiusPct}
          onChange={(e) => patch({ cornerRadiusPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{background.cornerRadiusPct}%</span>
      </label>

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Zoom</span>
        <input
          type="range"
          min={100}
          max={300}
          value={background.zoomPct}
          onChange={(e) => patch({ zoomPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{background.zoomPct}%</span>
      </label>

      <div className="background-edit-section">
        <span className="background-edit-label">Crop</span>
        <label className="background-edit-slider-row">
          <span className="background-edit-label">Top</span>
          <input
            type="range"
            min={0}
            max={45}
            value={background.cropTopPct}
            onChange={(e) => patch({ cropTopPct: Number(e.target.value) })}
          />
          <span className="background-edit-slider-value">{background.cropTopPct}%</span>
        </label>
        <label className="background-edit-slider-row">
          <span className="background-edit-label">Right</span>
          <input
            type="range"
            min={0}
            max={45}
            value={background.cropRightPct}
            onChange={(e) => patch({ cropRightPct: Number(e.target.value) })}
          />
          <span className="background-edit-slider-value">{background.cropRightPct}%</span>
        </label>
        <label className="background-edit-slider-row">
          <span className="background-edit-label">Bottom</span>
          <input
            type="range"
            min={0}
            max={45}
            value={background.cropBottomPct}
            onChange={(e) => patch({ cropBottomPct: Number(e.target.value) })}
          />
          <span className="background-edit-slider-value">{background.cropBottomPct}%</span>
        </label>
        <label className="background-edit-slider-row">
          <span className="background-edit-label">Left</span>
          <input
            type="range"
            min={0}
            max={45}
            value={background.cropLeftPct}
            onChange={(e) => patch({ cropLeftPct: Number(e.target.value) })}
          />
          <span className="background-edit-slider-value">{background.cropLeftPct}%</span>
        </label>
      </div>

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Backdrop blur</span>
        <input
          type="range"
          min={0}
          max={100}
          disabled={background.fill === "none"}
          value={background.blurPct}
          onChange={(e) => patch({ blurPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{background.blurPct}%</span>
      </label>

      <ResetRow
        onResetOriginal={() => onChange(DEFAULT_BACKGROUND_EDIT_SETTINGS)}
        onResetDefault={() => onChange(DEFAULT_BACKGROUND_EDIT_SETTINGS)}
        onResetAllToOriginal={onResetAllToOriginal}
        onResetAllToDefault={onResetAllToDefault}
      />
    </div>
  );
}
