import {
  PanelBottomClose,
  PanelTopClose,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { type BackgroundEditSettings } from "@shared/types/models";
import { ResetRow } from "./ResetRow";
import { BackdropPicker } from "./BackdropPicker";
import { CutChipRail, MASTER_CUT_ID, type CutChipRailCut } from "./CutChipRail";
import "./BackgroundEditPanel.css";

/** The edge(s) a platform's own OS chrome typically occupies — macOS has two independent
 *  ones (menu bar at the top, Dock at the bottom, toggled separately since either can be
 *  on/off/repositioned independently of the other), Windows and most Linux desktop
 *  environments just the one (taskbar/panel, bottom). Backs the "Remove menu bar"/"Remove
 *  Dock"/"Remove taskbar" quick toggles below: checked sets that side's crop to
 *  `presetPct` (roughly its real size), unchecked sets it back to 0 — the four granular
 *  Crop sliders further down stay available for anything more specific (a custom amount,
 *  cropping a side neither toggle covers, ...). Screen-only: the Ext Video tab has the
 *  same Crop sliders but no such toggle, since an added file isn't a recording of this
 *  machine's own desktop.  */
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
  cuts: CutChipRailCut[];
  activeCutId: string;
  onActiveCutChange: (id: string) => void;
  onClearOverride?: () => void;
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
  cuts,
  activeCutId,
  onActiveCutChange,
  onClearOverride,
}: BackgroundEditPanelProps) {
  const isMaster = activeCutId === MASTER_CUT_ID;
  function patch(partial: Partial<BackgroundEditSettings>) {
    onChange({ ...background, ...partial });
  }

  return (
    <div className="background-edit-panel">
      <CutChipRail showMaster cuts={cuts} activeId={activeCutId} onSelect={onActiveCutChange} onClearOverride={onClearOverride} />

      {/* System audio — the screen recording's own soundtrack on every platform (or the
          entire soundtrack, for an already-muxed single-file source with no separate mic).
          Independent of CameraEditPanel's own Audio section, which governs the mic. */}
      <div className="background-edit-row">
        <span className="background-edit-label">Audio</span>
        <button
          type="button"
          className={`background-edit-mute-btn${background.muted ? " on" : ""}`}
          aria-pressed={background.muted}
          onClick={() => patch({ muted: !background.muted })}
        >
          {background.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          {background.muted ? "Muted" : "Unmuted"}
        </button>
      </div>

      <BackdropPicker background={background} onPatch={patch} />

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
      {!isMaster && (
        <p className="background-edit-hint">Size positions the screen box for the whole recording (set on the Layout tab), not just this cut.</p>
      )}

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
