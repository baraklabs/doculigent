import { useState } from "react";
import {
  Ban,
  Palette,
  Sparkles,
  Image as ImageIcon,
  Images,
  Upload,
  Loader2,
  Pipette,
  PanelBottomClose,
  PanelTopClose,
  type LucideIcon,
} from "lucide-react";
import {
  BACKGROUND_COLORS,
  BACKGROUND_GRADIENTS,
  BACKGROUND_IMAGES,
  BACKGROUND_TEXTURES,
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

/** The edge(s) a platform's own OS chrome typically occupies — macOS has two independent
 *  ones (menu bar at the top, Dock at the bottom, toggled separately since either can be
 *  on/off/repositioned independently of the other), Windows and most Linux desktop
 *  environments just the one (taskbar/panel, bottom). Backs the "Remove menu bar"/"Remove
 *  Dock"/"Remove taskbar" quick toggles below: checked sets that side's crop to
 *  `presetPct` (roughly its real size), unchecked sets it back to 0 — the four granular
 *  Crop sliders further down stay available for anything more specific (a custom amount,
 *  cropping a side neither toggle covers, ...). */
const OS_CHROME_CROPS: { field: "cropTopPct" | "cropBottomPct"; label: string; presetPct: number; icon: LucideIcon }[] =
  window.api.system.platform === "darwin"
    ? [
        { field: "cropTopPct", label: "Remove menu bar", presetPct: 3, icon: PanelTopClose },
        { field: "cropBottomPct", label: "Remove Dock", presetPct: 6, icon: PanelBottomClose },
      ]
    : [{ field: "cropBottomPct", label: "Remove taskbar", presetPct: 4, icon: PanelBottomClose }];

interface BackgroundEditPanelProps {
  background: BackgroundEditSettings;
  /** What "Reset to original"/"Reset to default" restore — a fresh project's own starting
   *  point (see EditPage's defaultBackgroundEditSettingsForPlatform), which is
   *  platform-aware: a default crop matching OS_CHROME_CROP below, rather than the same
   *  fixed constant everywhere. */
  defaultBackground: BackgroundEditSettings;
  onChange: (next: BackgroundEditSettings) => void;
  /** The screen box's current width/height, each as a % of the canvas's own width/height
   *  — the same underlying values (LayoutEditSettings.freeScreenSizePct/HeightPct) that
   *  dragging the screen box's corner in the preview sets, kept here in sync in both
   *  directions rather than duplicated into BackgroundEditSettings. */
  screenSizePct: number;
  screenHeightPct: number;
  onScreenSizeChange: (sizePct: number, heightPct: number) => void;
  onResetAllToOriginal: () => void;
  onResetAllToDefault: () => void;
}

export function BackgroundEditPanel({
  background,
  defaultBackground,
  onChange,
  screenSizePct,
  screenHeightPct,
  onScreenSizeChange,
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

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Size</span>
        <input
          type="range"
          min={10}
          max={300}
          value={Math.round((screenSizePct + screenHeightPct) / 2)}
          onChange={(e) => {
            const v = Number(e.target.value);
            onScreenSizeChange(v, v);
          }}
        />
        <span className="background-edit-slider-value">{Math.round((screenSizePct + screenHeightPct) / 2)}%</span>
      </label>

      <div className="background-edit-section">
        {OS_CHROME_CROPS.map((chrome) => {
          const on = background[chrome.field] > 0;
          return (
            <button
              key={chrome.field}
              type="button"
              className={`background-mini-toggle${on ? " active" : ""}`}
              aria-pressed={on}
              onClick={() => patch({ [chrome.field]: on ? 0 : chrome.presetPct })}
            >
              <chrome.icon size={13} />
              {chrome.label}
              <span className="background-toggle-switch" data-on={on} />
            </button>
          );
        })}
      </div>

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Crop top</span>
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
        <span className="background-edit-label">Crop right</span>
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
        <span className="background-edit-label">Crop bottom</span>
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
        <span className="background-edit-label">Crop left</span>
        <input
          type="range"
          min={0}
          max={45}
          value={background.cropLeftPct}
          onChange={(e) => patch({ cropLeftPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{background.cropLeftPct}%</span>
      </label>

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
        onResetOriginal={() => onChange(defaultBackground)}
        onResetDefault={() => onChange(defaultBackground)}
        onResetAllToOriginal={onResetAllToOriginal}
        onResetAllToDefault={onResetAllToDefault}
      />
    </div>
  );
}
