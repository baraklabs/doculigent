import { Volume2, VolumeX } from "lucide-react";
import { DEFAULT_EXT_VIDEO_EDIT_SETTINGS, type ExtVideoEditSettings } from "@shared/types/models";
import { ResetRow } from "./ResetRow";
import { BackdropPicker } from "./BackdropPicker";
import { CutChipRail, type CutChipRailCut } from "./CutChipRail";
// Same controls, same look as the Screen tab — see BackdropPicker's own comment.
import "./BackgroundEditPanel.css";
import "./ExtVideoEditPanel.css";

interface ExtVideoEditPanelProps {
  extVideo: ExtVideoEditSettings;
  onChange: (next: ExtVideoEditSettings) => void;
  onResetAllToOriginal: () => void;
  onResetAllToDefault: () => void;
  /** One chip per piece on the Ext Video track (see EditPage's clipCuts) — "Main" edits
   *  the track's own master settings, a piece's chip edits just that piece's override. */
  cuts: CutChipRailCut[];
  activeCutId: string;
  onActiveCutChange: (id: string) => void;
  onClearOverride?: () => void;
  /** True while the track has nothing placed on it at all — the panel still works (it's
   *  editing the master settings the first placed piece will inherit), it just says so. */
  empty: boolean;
}

/** The Ext Video tab — how an added video file is composited when it plays. Deliberately
 *  the Screen tab's own control set (backdrop, padding, rounded corner, zoom, size, crop,
 *  backdrop blur, mute), since an Ext Video piece is drawn through the same fit/crop path
 *  the recording is; the two differences are that its box (size *and* position) is part of
 *  the piece's own settings rather than the Layout tab's, and that there's no "Remove
 *  taskbar"/"Remove menu bar" shortcut — an added file isn't a recording of this machine's
 *  desktop. The box is also drag/corner-resizable straight in the preview while the piece
 *  is on screen, which is what the Size slider here mirrors. See ExtVideoEditSettings. */
export function ExtVideoEditPanel({
  extVideo,
  onChange,
  onResetAllToOriginal,
  onResetAllToDefault,
  cuts,
  activeCutId,
  onActiveCutChange,
  onClearOverride,
  empty,
}: ExtVideoEditPanelProps) {
  function patch(partial: Partial<ExtVideoEditSettings>) {
    onChange({ ...extVideo, ...partial });
  }

  return (
    <div className="background-edit-panel ext-video-edit-panel">
      <CutChipRail showMaster cuts={cuts} activeId={activeCutId} onSelect={onActiveCutChange} onClearOverride={onClearOverride} />

      {empty && (
        <p className="background-edit-hint ext-video-empty-hint">
          Nothing on the Ext Video track yet — add a video from the Media panel, then drag it
          onto the track. These settings apply to whatever lands there.
        </p>
      )}

      {/* The inserted file brings its own soundtrack with it (see renderExportAudio) —
          this is what silences it, e.g. for b-roll played under the recording's narration. */}
      <div className="background-edit-row">
        <span className="background-edit-label">Audio</span>
        <button
          type="button"
          className={`background-edit-mute-btn${extVideo.muted ? " on" : ""}`}
          aria-pressed={extVideo.muted}
          onClick={() => patch({ muted: !extVideo.muted })}
        >
          {extVideo.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          {extVideo.muted ? "Muted" : "Unmuted"}
        </button>
      </div>

      <BackdropPicker background={extVideo} onPatch={patch} />

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Padding</span>
        <input
          type="range"
          min={0}
          max={20}
          value={extVideo.paddingPct}
          onChange={(e) => patch({ paddingPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{extVideo.paddingPct}%</span>
      </label>

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Rounded corner</span>
        <input
          type="range"
          min={0}
          max={20}
          value={extVideo.cornerRadiusPct}
          onChange={(e) => patch({ cornerRadiusPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{extVideo.cornerRadiusPct}%</span>
      </label>

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Zoom</span>
        <input
          type="range"
          min={100}
          max={300}
          value={extVideo.zoomPct}
          onChange={(e) => patch({ zoomPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{extVideo.zoomPct}%</span>
      </label>

      {/* One slider for both axes, same as the Screen tab's — dragging the box's corner
          in the preview is what sets width and height independently (and what moves it off
          center), so this shows their average and re-squares them when moved. */}
      <label className="background-edit-slider-row">
        <span className="background-edit-label">Size</span>
        <input
          type="range"
          min={10}
          max={300}
          value={Math.round((extVideo.sizePct + extVideo.heightPct) / 2)}
          onChange={(e) => {
            const v = Number(e.target.value);
            patch({ sizePct: v, heightPct: v });
          }}
        />
        <span className="background-edit-slider-value">{Math.round((extVideo.sizePct + extVideo.heightPct) / 2)}%</span>
      </label>

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Crop top</span>
        <input
          type="range"
          min={0}
          max={45}
          value={extVideo.cropTopPct}
          onChange={(e) => patch({ cropTopPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{extVideo.cropTopPct}%</span>
      </label>
      <label className="background-edit-slider-row">
        <span className="background-edit-label">Crop right</span>
        <input
          type="range"
          min={0}
          max={45}
          value={extVideo.cropRightPct}
          onChange={(e) => patch({ cropRightPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{extVideo.cropRightPct}%</span>
      </label>
      <label className="background-edit-slider-row">
        <span className="background-edit-label">Crop bottom</span>
        <input
          type="range"
          min={0}
          max={45}
          value={extVideo.cropBottomPct}
          onChange={(e) => patch({ cropBottomPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{extVideo.cropBottomPct}%</span>
      </label>
      <label className="background-edit-slider-row">
        <span className="background-edit-label">Crop left</span>
        <input
          type="range"
          min={0}
          max={45}
          value={extVideo.cropLeftPct}
          onChange={(e) => patch({ cropLeftPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{extVideo.cropLeftPct}%</span>
      </label>

      <label className="background-edit-slider-row">
        <span className="background-edit-label">Backdrop blur</span>
        <input
          type="range"
          min={0}
          max={100}
          disabled={extVideo.fill === "none"}
          value={extVideo.blurPct}
          onChange={(e) => patch({ blurPct: Number(e.target.value) })}
        />
        <span className="background-edit-slider-value">{extVideo.blurPct}%</span>
      </label>

      <ResetRow
        onResetOriginal={() => onChange(DEFAULT_EXT_VIDEO_EDIT_SETTINGS)}
        onResetDefault={() => onChange(DEFAULT_EXT_VIDEO_EDIT_SETTINGS)}
        onResetAllToOriginal={onResetAllToOriginal}
        onResetAllToDefault={onResetAllToDefault}
      />
    </div>
  );
}
