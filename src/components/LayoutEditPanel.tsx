import {
  Rows2,
  RectangleHorizontal,
  PictureInPicture2,
  SquareSplitHorizontal,
  PanelTop,
  PanelBottom,
  ArrowUpToLine,
  ArrowDownToLine,
  type LucideIcon,
} from "lucide-react";
import {
  DEFAULT_LAYOUT_EDIT_SETTINGS,
  type EditProjectMedia,
  type FreePosition,
  type LandscapeMode,
  type LayoutEditSettings,
  type LayoutFormat,
} from "@shared/types/models";
import { ResetRow } from "./ResetRow";
import { CutChipRail, MASTER_CUT_ID, type CutChipRailCut } from "./CutChipRail";
import "./LayoutEditPanel.css";

const FORMATS: { id: LayoutFormat; label: string; sublabel: string; icon: LucideIcon }[] = [
  { id: "landscape", label: "Landscape", sublabel: "Fixed 16:9 wide canvas", icon: RectangleHorizontal },
  { id: "reel", label: "9:16", sublabel: "Reel, portrait, for shorts", icon: Rows2 },
];

/** "landscape" only — which of the two camera/screen relationships it starts from. */
const LANDSCAPE_MODES: { id: LandscapeMode; label: string; sublabel: string; icon: LucideIcon }[] = [
  { id: "overlay", label: "Overlay", sublabel: "Camera floats over a full-bleed screen", icon: PictureInPicture2 },
  { id: "split", label: "Split", sublabel: "Screen and camera side by side", icon: SquareSplitHorizontal },
];

type QuickLayout = {
  id: string;
  label: string;
  icon: LucideIcon;
  apply: Partial<LayoutEditSettings>;
};

/** Reel's quick layouts — the screen is always full width. The first two center a
 *  moderate-height screen and camera at 25%/75% down the canvas (letterboxed, honoring
 *  whatever padding/zoom is set on the Camera/Screen tabs); the "(full)" pair instead
 *  makes the screen's height full too — genuinely edge to edge, cropped to cover rather
 *  than letterboxed (reelScreenFull — see PreviewCompositor; a typically-landscape
 *  recording could otherwise never letterbox-fit a portrait canvas's full height) — with
 *  the camera pinned flush to the top or bottom edge on top of it. All four are just
 *  one-click starting points: drag/resize either box afterward like anywhere else. */
const REEL_LAYOUTS: QuickLayout[] = [
  {
    id: "reel-screen-top",
    label: "Screen on top",
    icon: PanelTop,
    apply: {
      freeScreenSizePct: 100,
      freeScreenHeightPct: 45,
      freeScreenPos: { xPct: 50, yPct: 25 },
      freeCameraPos: { xPct: 50, yPct: 75 },
      reelScreenFull: false,
    },
  },
  {
    id: "reel-camera-top",
    label: "Camera on top",
    icon: PanelBottom,
    apply: {
      freeScreenSizePct: 100,
      freeScreenHeightPct: 45,
      freeScreenPos: { xPct: 50, yPct: 75 },
      freeCameraPos: { xPct: 50, yPct: 25 },
      reelScreenFull: false,
    },
  },
  {
    id: "reel-screen-top-full",
    label: "Screen on top (full)",
    icon: ArrowUpToLine,
    apply: {
      freeScreenSizePct: 100,
      freeScreenHeightPct: 100,
      // {50,50} on both axes — the screen is full-bleed both ways here, so there's no
      // travel range left to place a percentage within (see pctToOffset/DEGENERATE_TRAVEL_PX
      // in PreviewCompositor); 50 is that scheme's "no manual offset yet" neutral point,
      // which is what actually keeps it flush on-canvas until the user drags it themselves.
      freeScreenPos: { xPct: 50, yPct: 50 },
      freeCameraPos: { xPct: 50, yPct: 100 },
      reelScreenFull: true,
    },
  },
  {
    id: "reel-camera-top-full",
    label: "Camera on top (full)",
    icon: ArrowDownToLine,
    apply: {
      freeScreenSizePct: 100,
      freeScreenHeightPct: 100,
      freeScreenPos: { xPct: 50, yPct: 50 },
      freeCameraPos: { xPct: 50, yPct: 0 },
      reelScreenFull: true,
    },
  },
];

// Row-major 3x3 traversal for the "Camera position" grid — the center cell is always the
// non-selectable "screen" placeholder.
const GRID_ORDER = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

type GridSlot = Exclude<(typeof GRID_ORDER)[number], "center">;

/** One "Camera position" preset per grid cell (with a dot) — one click, not a locked
 *  mode. Both "overlay" and "split" get all 8 (corners + edge midpoints); what each does
 *  to the screen differs (see buildOverlaySlots/buildSplitSlots below) — "overlay" also
 *  sets the screen full-bleed, "split" only ever touches the camera. */
const CAMERA_POSITIONS: { slot: GridSlot; label: string; cameraPos: FreePosition }[] = [
  { slot: "top-left", label: "Camera top-left", cameraPos: { xPct: 0, yPct: 0 } },
  { slot: "top-center", label: "Camera top", cameraPos: { xPct: 50, yPct: 0 } },
  { slot: "top-right", label: "Camera top-right", cameraPos: { xPct: 100, yPct: 0 } },
  { slot: "middle-left", label: "Camera left", cameraPos: { xPct: 0, yPct: 50 } },
  { slot: "middle-right", label: "Camera right", cameraPos: { xPct: 100, yPct: 50 } },
  { slot: "bottom-left", label: "Camera bottom-left", cameraPos: { xPct: 0, yPct: 100 } },
  { slot: "bottom-center", label: "Camera bottom", cameraPos: { xPct: 50, yPct: 100 } },
  { slot: "bottom-right", label: "Camera bottom-right", cameraPos: { xPct: 100, yPct: 100 } },
];

/** "overlay": screen always starts full-bleed (100x100) regardless of where the camera
 *  lands, since the two are expected to overlap. */
function buildOverlaySlots(): Record<GridSlot, QuickLayout> {
  const out = {} as Record<GridSlot, QuickLayout>;
  for (const p of CAMERA_POSITIONS) {
    out[p.slot] = {
      id: `overlay-${p.slot}`,
      label: p.label,
      icon: PictureInPicture2,
      apply: {
        freeScreenSizePct: 100,
        freeScreenHeightPct: 100,
        freeScreenPos: { xPct: 50, yPct: 50 },
        freeCameraPos: p.cameraPos,
      },
    };
  }
  return out;
}

/** "split": only positions the camera — screen isn't touched here at all. freeScreenPos
 *  reset to null explicitly (rather than left alone) is what tells PreviewCompositor
 *  "nothing set in screen", so it derives the screen's box to fill whatever the camera
 *  isn't using, live, until the moment the user actually drags/resizes the screen
 *  themselves (which sets freeScreenPos to a real value and permanently hands control
 *  back to them — clicking a split preset again is how they'd get the auto-fill back). */
function buildSplitSlots(): Record<GridSlot, QuickLayout> {
  const out = {} as Record<GridSlot, QuickLayout>;
  for (const p of CAMERA_POSITIONS) {
    out[p.slot] = {
      id: `split-${p.slot}`,
      label: p.label,
      icon: PictureInPicture2,
      apply: {
        freeScreenPos: null,
        freeCameraPos: p.cameraPos,
      },
    };
  }
  return out;
}

const OVERLAY_SLOTS = buildOverlaySlots();
const SPLIT_SLOTS = buildSplitSlots();

interface LayoutEditPanelProps {
  media: EditProjectMedia | undefined;
  mediaLoading: boolean;
  layout: LayoutEditSettings;
  onChange: (next: LayoutEditSettings) => void;
  onResetAllToOriginal: () => void;
  onResetAllToDefault: () => void;
  cuts: CutChipRailCut[];
  activeCutId: string;
  onActiveCutChange: (id: string) => void;
  onClearOverride?: () => void;
}

export function LayoutEditPanel({
  media,
  mediaLoading,
  layout,
  onChange,
  onResetAllToOriginal,
  onResetAllToDefault,
  cuts,
  activeCutId,
  onActiveCutChange,
  onClearOverride,
}: LayoutEditPanelProps) {
  const isMaster = activeCutId === MASTER_CUT_ID;
  function patch(partial: Partial<LayoutEditSettings>) {
    onChange({ ...layout, ...partial });
  }

  // Projects saved while "overlay"/"split" were still their own top-level formats (or,
  // further back, "custom"/"own") carry a format string that no longer exists — fall back
  // rather than rendering with no matching quick-layout list.
  const format: LayoutFormat = layout.format === "reel" ? "reel" : "landscape";
  const landscapeMode: LandscapeMode = layout.landscapeMode === "split" ? "split" : "overlay";

  if (mediaLoading) {
    return (
      <div className="layout-edit-empty">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!media?.editable) {
    return (
      <div className="layout-edit-empty">
        <p className="muted">
          {media?.singleFilePath
            ? "The reel format needs the camera as a separate track from the screen, which isn't available for this recording."
            : "This project has no linked recording with a camera to lay out."}
        </p>
      </div>
    );
  }

  return (
    <div className="layout-edit-panel">
      <CutChipRail showMaster cuts={cuts} activeId={activeCutId} onSelect={onActiveCutChange} onClearOverride={onClearOverride} />

      <div className="layout-edit-section">
        <span className="layout-edit-label">Format</span>
        <div className="layout-mode-grid">
          {FORMATS.map((f) => {
            const Icon = f.icon;
            return (
              <button
                key={f.id}
                type="button"
                className={`layout-mode-tile${format === f.id ? " active" : ""}`}
                aria-pressed={format === f.id}
                onClick={() => patch({ format: f.id })}
              >
                <Icon size={20} />
                <span className="layout-mode-tile-label">{f.label}</span>
                <span className="layout-mode-tile-sublabel">{f.sublabel}</span>
              </button>
            );
          })}
        </div>
      </div>

      {format === "reel" ? (
        <div className="layout-edit-section">
          <span className="layout-edit-label">Quick layouts</span>
          <div className="layout-mode-grid">
            {REEL_LAYOUTS.map((q) => {
              const Icon = q.icon;
              return (
                <button key={q.id} type="button" className="layout-mode-tile" onClick={() => patch(q.apply)}>
                  <Icon size={20} />
                  <span className="layout-mode-tile-label">{q.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <>
          <div className="layout-edit-section">
            <span className="layout-edit-label">Style</span>
            <div className="layout-mode-grid">
              {LANDSCAPE_MODES.map((m) => {
                const Icon = m.icon;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`layout-mode-tile${landscapeMode === m.id ? " active" : ""}`}
                    aria-pressed={landscapeMode === m.id}
                    onClick={() => patch({ landscapeMode: m.id })}
                  >
                    <Icon size={20} />
                    <span className="layout-mode-tile-label">{m.label}</span>
                    <span className="layout-mode-tile-sublabel">{m.sublabel}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="layout-edit-section">
            <span className="layout-edit-label">Camera position</span>
            <div className="layout-position-picker">
              {GRID_ORDER.map((slot) => {
                const q = slot === "center" ? undefined : (landscapeMode === "overlay" ? OVERLAY_SLOTS : SPLIT_SLOTS)[slot];
                if (!q) {
                  return <div key={slot} className="layout-position-cell layout-position-cell-center" aria-hidden="true" />;
                }
                return (
                  <button
                    key={q.id}
                    type="button"
                    className="layout-position-cell"
                    title={q.label}
                    aria-label={q.label}
                    onClick={() => patch(q.apply)}
                  >
                    <span className="layout-position-dot" />
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      <p className="layout-edit-hint">
        {isMaster
          ? "Drag the screen and camera directly in the preview to place them, or drag their bottom-right corner to resize — they snap to guide lines at the canvas edges and center, and can be dragged partially or fully out of frame. Camera, sound, and cursor each render exactly as set on their own tab."
          : "Quick layouts apply to this cut only. Dragging the screen/camera directly in the preview still repositions Main, not this cut — use a quick layout above to set this cut's own position."}
      </p>

      <ResetRow
        onResetOriginal={() => onChange(DEFAULT_LAYOUT_EDIT_SETTINGS)}
        onResetDefault={() => onChange(DEFAULT_LAYOUT_EDIT_SETTINGS)}
        onResetAllToOriginal={onResetAllToOriginal}
        onResetAllToDefault={onResetAllToDefault}
      />
    </div>
  );
}
