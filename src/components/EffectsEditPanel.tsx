import { Box, Circle, Droplets, Focus, Plus, RotateCcw, Square, Trash2, ZoomIn } from "lucide-react";
import {
  BACKGROUND_GRADIENTS,
  ZOOM_PCT_PRESETS,
  type TimelineEffect,
  type TimelineEffectKind,
  type TimelineZoom,
  type TimelineZoomStyle,
  type TimelineZoomTilt,
} from "@shared/types/models";
import { CALLOUT_COLORS } from "@shared/lib/timelineEffects";
import { TILT_CUSTOM_ANGLE_LIMIT_DEG, TILT_DIRECTION_PRESETS } from "@shared/lib/timelineZooms";
import "./EffectsEditPanel.css";

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSecs = ms / 1000;
  const m = Math.floor(totalSecs / 60);
  const s = (totalSecs % 60).toFixed(1);
  return `${m}:${s.padStart(4, "0")}`;
}

/** Which of the Effects tab's three blocks the nav/content pane currently shows — Zoom is
 *  its own kind here (a TimelineZoom, not a TimelineEffect), kept first/top of NAV_ITEMS to
 *  match the Timeline's own row order (Zoom sits directly above Callout/Blur there too). */
export type EffectsNavKind = "zoom" | TimelineEffectKind;

const NAV_ITEMS: { kind: EffectsNavKind; label: string; icon: typeof Focus }[] = [
  { kind: "zoom", label: "Zoom", icon: ZoomIn },
  { kind: "callout", label: "Callout", icon: Focus },
  { kind: "blur", label: "Blur", icon: Droplets },
];

const ZOOM_STYLES: { id: TimelineZoomStyle; label: string; icon: typeof Square }[] = [
  { id: "2d", label: "2D", icon: Square },
  { id: "3d", label: "3D", icon: Box },
];

interface FxTiltSliderRowProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  onReset: () => void;
}

/** Shared single-line "label, slider, value, reset icon" row for a Tilt X/Tilt Y control —
 *  used by Callout's own tilt section, Zoom's Custom tilt below, and nowhere else, so the
 *  two feel identical. Same TILT_CUSTOM_ANGLE_LIMIT_DEG range the old standalone
 *  ZoomEditPanel used. */
function FxTiltSliderRow({ label, value, onChange, onReset }: FxTiltSliderRowProps) {
  return (
    <div className="fx-tilt-slider-row">
      <span className="fx-tilt-slider-label">{label}</span>
      <input
        type="range"
        className="fx-tilt-slider-input"
        min={-TILT_CUSTOM_ANGLE_LIMIT_DEG}
        max={TILT_CUSTOM_ANGLE_LIMIT_DEG}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="fx-tilt-slider-value">{Math.round(value)}</span>
      <button
        type="button"
        className="fx-tilt-slider-reset"
        onClick={onReset}
        disabled={value === 0}
        title={`Reset ${label}`}
        aria-label={`Reset ${label}`}
      >
        <RotateCcw size={12} />
      </button>
    </div>
  );
}

interface EffectSettingsProps {
  effect: TimelineEffect;
  onPatch: (patch: Partial<TimelineEffect>) => void;
  onRemove: () => void;
}

/** The selected box's own controls, rendered inside whichever block owns it. Callout and
 *  blur share the box/shape/timing rows and differ only in what they paint, so the middle
 *  section is the one that swaps. */
function EffectSettings({ effect, onPatch, onRemove }: EffectSettingsProps) {
  return (
    <div className="fx-settings">
      <div className="fx-row">
        <span className="fx-label">Shape</span>
        <div className="fx-segmented">
          <button
            type="button"
            className={`fx-seg-btn${effect.shape === "rect" ? " active" : ""}`}
            aria-pressed={effect.shape === "rect"}
            onClick={() => onPatch({ shape: "rect" })}
          >
            <Square size={13} />
            Box
          </button>
          <button
            type="button"
            className={`fx-seg-btn${effect.shape === "ellipse" ? " active" : ""}`}
            aria-pressed={effect.shape === "ellipse"}
            onClick={() => onPatch({ shape: "ellipse" })}
          >
            <Circle size={13} />
            Oval
          </button>
        </div>
      </div>

      {effect.kind === "callout" ? (
        <>
          <label className="fx-slider-row">
            <span className="fx-label">Dim outside</span>
            <input
              type="range"
              min={0}
              max={90}
              value={effect.dimPct}
              onChange={(e) => onPatch({ dimPct: Number(e.target.value) })}
            />
            <span className="fx-slider-value">{effect.dimPct}%</span>
          </label>

          <label className="fx-text-row">
            <span className="fx-label">Label</span>
            <input
              type="text"
              className="fx-text-input"
              placeholder="Optional caption"
              maxLength={60}
              value={effect.label}
              onChange={(e) => onPatch({ label: e.target.value })}
            />
          </label>

          <div className="fx-row">
            <span className="fx-label">Animation</span>
            <div className="fx-segmented">
              <button
                type="button"
                className={`fx-seg-btn${!effect.popupAnim ? " active" : ""}`}
                aria-pressed={!effect.popupAnim}
                onClick={() => onPatch({ popupAnim: false })}
              >
                None
              </button>
              <button
                type="button"
                className={`fx-seg-btn${effect.popupAnim ? " active" : ""}`}
                aria-pressed={effect.popupAnim}
                onClick={() => onPatch({ popupAnim: true })}
              >
                Popout
              </button>
            </div>
          </div>

          {/* How far the whole box (dim cutout, border/marquee, label) zooms in at the peak
              of the Popout animation — everything outside the box is never touched. */}
          {effect.popupAnim && (
            <label className="fx-slider-row">
              <span className="fx-label">Zoom</span>
              <input
                type="range"
                min={100}
                max={300}
                value={effect.popupZoomPct}
                onChange={(e) => onPatch({ popupZoomPct: Number(e.target.value) })}
              />
              <span className="fx-slider-value">{effect.popupZoomPct}%</span>
            </label>
          )}

          {/* 3D tilt on the box's own outline — same preset grid/Custom sliders/range as
              the Zoom track's own Tilt section (see FxTiltSliderRow), just applied to this
              box's shape instead of the screen content. */}
          <div className="fx-tilt-section">
            <span className="fx-label">Tilt</span>
            <div className="fx-tilt-preset-grid">
              {TILT_DIRECTION_PRESETS.map((p) => {
                const isActive = effect.tilt.xDeg === p.xDeg && effect.tilt.yDeg === p.yDeg;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`fx-tilt-preset-btn${isActive ? " active" : ""}`}
                    title={p.label}
                    aria-label={p.label}
                    aria-pressed={isActive}
                    onClick={() => onPatch({ tilt: { xDeg: p.xDeg, yDeg: p.yDeg } })}
                  >
                    <span
                      className="fx-tilt-preset-swatch"
                      style={{ transform: `perspective(60px) rotateX(${p.xDeg}deg) rotateY(${p.yDeg}deg)` }}
                    />
                  </button>
                );
              })}
            </div>
            <span className="fx-tilt-custom-label">Custom</span>
            <div className="fx-tilt-custom-sliders">
              <FxTiltSliderRow
                label="Tilt X"
                value={effect.tilt.xDeg}
                onChange={(v) => onPatch({ tilt: { ...effect.tilt, xDeg: v } })}
                onReset={() => onPatch({ tilt: { ...effect.tilt, xDeg: 0 } })}
              />
              <FxTiltSliderRow
                label="Tilt Y"
                value={effect.tilt.yDeg}
                onChange={(v) => onPatch({ tilt: { ...effect.tilt, yDeg: v } })}
                onReset={() => onPatch({ tilt: { ...effect.tilt, yDeg: 0 } })}
              />
            </div>
          </div>

          <label className="fx-slider-row">
            <span className="fx-label">Border</span>
            <input
              type="range"
              min={0}
              max={50}
              value={Math.round(effect.borderPct * 10)}
              onChange={(e) => onPatch({ borderPct: Number(e.target.value) / 10 })}
            />
            <span className="fx-slider-value">{effect.borderPct.toFixed(1)}%</span>
          </label>

          {/* Marquee replaces the plain Border stroke above with an animated one — Glow
              (a pulsing halo) or Chase (a bright segment orbiting the box's own perimeter,
              classic marquee-light motion), in a solid color or a gradient, each pickable
              from a preset list or a custom picker right below it. While it's off, this is
              also where the plain border/label Color lives — the border's own color has
              nowhere else to come from until Marquee takes over supplying it. */}
          <div className="fx-marquee-section">
            <div className="fx-row">
              <span className="fx-label">Marquee</span>
              <div className="fx-segmented">
                <button
                  type="button"
                  className={`fx-seg-btn${!effect.marquee ? " active" : ""}`}
                  aria-pressed={!effect.marquee}
                  onClick={() => onPatch({ marquee: false })}
                >
                  Off
                </button>
                <button
                  type="button"
                  className={`fx-seg-btn${effect.marquee ? " active" : ""}`}
                  aria-pressed={effect.marquee}
                  onClick={() => onPatch({ marquee: true })}
                >
                  On
                </button>
              </div>
            </div>

            {!effect.marquee && (
              <div className="fx-row">
                <span className="fx-label">Color</span>
                <div className="fx-swatches">
                  {CALLOUT_COLORS.map((c) => (
                    <span key={c.id} className="fx-swatch-wrap">
                      <button
                        type="button"
                        className="fx-swatch"
                        style={{ background: c.color }}
                        title={c.label}
                        aria-label={c.label}
                        aria-pressed={effect.color === c.color}
                        onClick={() => onPatch({ color: c.color })}
                      />
                      {effect.color === c.color && <span className="fx-swatch-dot" />}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {effect.marquee && (
              <>
                <div className="fx-row">
                  <span className="fx-label">Style</span>
                  <div className="fx-segmented">
                    <button
                      type="button"
                      className={`fx-seg-btn${effect.marqueeStyle === "glow" ? " active" : ""}`}
                      aria-pressed={effect.marqueeStyle === "glow"}
                      onClick={() => onPatch({ marqueeStyle: "glow" })}
                    >
                      Glow
                    </button>
                    <button
                      type="button"
                      className={`fx-seg-btn${effect.marqueeStyle === "orbit" ? " active" : ""}`}
                      aria-pressed={effect.marqueeStyle === "orbit"}
                      onClick={() => onPatch({ marqueeStyle: "orbit" })}
                    >
                      Chase
                    </button>
                  </div>
                </div>

                <div className="fx-row">
                  <span className="fx-label">Color</span>
                  <div className="fx-segmented">
                    <button
                      type="button"
                      className={`fx-seg-btn${effect.marqueeColorMode === "solid" ? " active" : ""}`}
                      aria-pressed={effect.marqueeColorMode === "solid"}
                      onClick={() => onPatch({ marqueeColorMode: "solid" })}
                    >
                      Solid
                    </button>
                    <button
                      type="button"
                      className={`fx-seg-btn${effect.marqueeColorMode === "gradient" ? " active" : ""}`}
                      aria-pressed={effect.marqueeColorMode === "gradient"}
                      onClick={() => onPatch({ marqueeColorMode: "gradient" })}
                    >
                      Gradient
                    </button>
                  </div>
                </div>

                {effect.marqueeColorMode === "solid" ? (
                  <div className="fx-swatches fx-swatches-with-picker">
                    {CALLOUT_COLORS.map((c) => (
                      <span key={c.id} className="fx-swatch-wrap">
                        <button
                          type="button"
                          className="fx-swatch"
                          style={{ background: c.color }}
                          title={c.label}
                          aria-label={c.label}
                          aria-pressed={effect.marqueeColor === c.color}
                          onClick={() => onPatch({ marqueeColor: c.color })}
                        />
                        {effect.marqueeColor === c.color && <span className="fx-swatch-dot" />}
                      </span>
                    ))}
                    {/* Same size/shape as the preset swatches above, with a real <input
                        type="color"> stretched invisibly over the whole tile — the tile
                        itself just shows whatever color is currently picked, custom or not,
                        same technique BackdropPicker's own custom swatch uses. */}
                    <span className="fx-swatch-wrap">
                      <label
                        className="fx-swatch fx-swatch-custom"
                        style={{ background: effect.marqueeColor }}
                        title="Custom color"
                      >
                        <input
                          type="color"
                          aria-label="Custom marquee color"
                          value={effect.marqueeColor}
                          onChange={(e) => onPatch({ marqueeColor: e.target.value })}
                        />
                      </label>
                      {!CALLOUT_COLORS.some((c) => c.color === effect.marqueeColor) && <span className="fx-swatch-dot" />}
                    </span>
                  </div>
                ) : (
                  <div className="fx-swatches fx-swatches-with-picker">
                    {BACKGROUND_GRADIENTS.map((g) => {
                      const isActive = effect.marqueeGradientFrom === g.from && effect.marqueeGradientTo === g.to;
                      return (
                        <span key={g.id} className="fx-swatch-wrap">
                          <button
                            type="button"
                            className="fx-gradient-swatch"
                            style={{ background: `linear-gradient(${g.angleDeg}deg, ${g.from}, ${g.to})` }}
                            title={g.label}
                            aria-label={g.label}
                            aria-pressed={isActive}
                            onClick={() => onPatch({ marqueeGradientFrom: g.from, marqueeGradientTo: g.to })}
                          />
                          {isActive && <span className="fx-swatch-dot" />}
                        </span>
                      );
                    })}
                    {/* Same split-tile technique as the Screen tab's own custom gradient
                        swatch (see BackdropPicker) — two <input type="color">, each
                        stretched invisibly over its own half of the tile, so From/To are
                        each their own real picker rather than one color with the other
                        derived from it. */}
                    <span className="fx-swatch-wrap">
                      <div
                        className="fx-gradient-swatch fx-gradient-swatch-custom"
                        style={{ background: `linear-gradient(135deg, ${effect.marqueeGradientFrom}, ${effect.marqueeGradientTo})` }}
                        title="Custom gradient"
                      >
                        <input
                          type="color"
                          title="From"
                          aria-label="Custom gradient — from color"
                          value={effect.marqueeGradientFrom}
                          onChange={(e) => onPatch({ marqueeGradientFrom: e.target.value })}
                        />
                        <input
                          type="color"
                          title="To"
                          aria-label="Custom gradient — to color"
                          value={effect.marqueeGradientTo}
                          onChange={(e) => onPatch({ marqueeGradientTo: e.target.value })}
                        />
                      </div>
                      {!BACKGROUND_GRADIENTS.some((g) => g.from === effect.marqueeGradientFrom && g.to === effect.marqueeGradientTo) && (
                        <span className="fx-swatch-dot" />
                      )}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="fx-row">
            <span className="fx-label">Style</span>
            <div className="fx-segmented">
              <button
                type="button"
                className={`fx-seg-btn${!effect.pixelate ? " active" : ""}`}
                aria-pressed={!effect.pixelate}
                onClick={() => onPatch({ pixelate: false })}
              >
                Blur
              </button>
              <button
                type="button"
                className={`fx-seg-btn${effect.pixelate ? " active" : ""}`}
                aria-pressed={effect.pixelate}
                onClick={() => onPatch({ pixelate: true })}
              >
                Pixelate
              </button>
            </div>
          </div>

          <label className="fx-slider-row">
            <span className="fx-label">Strength</span>
            <input
              type="range"
              min={5}
              max={100}
              value={effect.blurPct}
              onChange={(e) => onPatch({ blurPct: Number(e.target.value) })}
            />
            <span className="fx-slider-value">{effect.blurPct}%</span>
          </label>
        </>
      )}

      {/* Rounding applies to the drawn ring for a callout and to the clipped region for a
          blur, so it's shared rather than sitting in either branch above. */}
      {effect.shape === "rect" && (
        <label className="fx-slider-row">
          <span className="fx-label">Rounded corner</span>
          <input
            type="range"
            min={0}
            max={50}
            value={effect.cornerPct}
            onChange={(e) => onPatch({ cornerPct: Number(e.target.value) })}
          />
          <span className="fx-slider-value">{effect.cornerPct}%</span>
        </label>
      )}

      {/* Timing lives on the Timeline — this block has its own row down there (Callout or
          Blur), where it's dragged and edge-trimmed like a zoom. Shown read-only here so the
          panel still says when the selected box actually appears. */}
      <div className="fx-timing">
        <div className="fx-row">
          <span className="fx-label">Shows</span>
          <span className="fx-timing-value">
            {formatTime(effect.startMs)} – {formatTime(effect.startMs + effect.durationMs)}
          </span>
        </div>
      </div>

      <button type="button" className="fx-remove-btn" onClick={onRemove}>
        <Trash2 size={13} />
        Remove this {effect.kind}
      </button>
    </div>
  );
}

interface ZoomSettingsProps {
  zoom: TimelineZoom;
  onSetPct: (pct: number) => void;
  onSetStyle: (style: TimelineZoomStyle) => void;
  onSetTilt: (patch: Partial<TimelineZoomTilt>) => void;
  onRemove: () => void;
}

/** Zoom's own controls — same "fx-settings" shell as Callout/Blur's EffectSettings above, so
 *  all three blocks read as one panel, just swapping what's inside. Zoom amount and style are
 *  preset pickers rather than free sliders (matches the old standalone ZoomEditPanel), and
 *  the Tilt section only appears once "3D" is picked. */
function ZoomSettings({ zoom, onSetPct, onSetStyle, onSetTilt, onRemove }: ZoomSettingsProps) {
  return (
    <div className="fx-settings">
      <div className="fx-row">
        <span className="fx-label">Zoom amount</span>
        <div className="fx-pct-presets">
          {ZOOM_PCT_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={`fx-pct-btn${zoom.pct === p ? " active" : ""}`}
              onClick={() => onSetPct(p)}
            >
              {p}%
            </button>
          ))}
        </div>
      </div>

      <div className="fx-row">
        <span className="fx-label">Style</span>
        <div className="fx-segmented">
          {ZOOM_STYLES.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                type="button"
                className={`fx-seg-btn${zoom.style === s.id ? " active" : ""}`}
                aria-pressed={zoom.style === s.id}
                onClick={() => onSetStyle(s.id)}
              >
                <Icon size={13} />
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      {zoom.style === "3d" && (
        <div className="fx-tilt-section">
          <span className="fx-label">Tilt</span>
          <div className="fx-tilt-preset-grid">
            {TILT_DIRECTION_PRESETS.map((p) => {
              const isActive = zoom.tilt.xDeg === p.xDeg && zoom.tilt.yDeg === p.yDeg;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`fx-tilt-preset-btn${isActive ? " active" : ""}`}
                  title={p.label}
                  aria-label={p.label}
                  aria-pressed={isActive}
                  onClick={() => onSetTilt({ xDeg: p.xDeg, yDeg: p.yDeg })}
                >
                  <span
                    className="fx-tilt-preset-swatch"
                    style={{ transform: `perspective(60px) rotateX(${p.xDeg}deg) rotateY(${p.yDeg}deg)` }}
                  />
                </button>
              );
            })}
          </div>

          <span className="fx-tilt-custom-label">Custom</span>
          <div className="fx-tilt-custom-sliders">
            <FxTiltSliderRow
              label="Tilt X"
              value={zoom.tilt.xDeg}
              onChange={(v) => onSetTilt({ xDeg: v })}
              onReset={() => onSetTilt({ xDeg: 0 })}
            />
            <FxTiltSliderRow
              label="Tilt Y"
              value={zoom.tilt.yDeg}
              onChange={(v) => onSetTilt({ yDeg: v })}
              onReset={() => onSetTilt({ yDeg: 0 })}
            />
          </div>
        </div>
      )}

      <div className="fx-timing">
        <div className="fx-row">
          <span className="fx-label">Shows</span>
          <span className="fx-timing-value">
            {formatTime(zoom.startMs)} – {formatTime(zoom.startMs + zoom.durationMs)}
          </span>
        </div>
      </div>

      <button type="button" className="fx-remove-btn" onClick={onRemove}>
        <Trash2 size={13} />
        Remove this zoom
      </button>
    </div>
  );
}

interface EffectsEditPanelProps {
  /** Which of the three blocks (Zoom/Callout/Blur) the nav/content pane shows — owned by
   *  EditPage rather than local state, so a Timeline click (which already knows exactly
   *  which kind it hit) sets this directly in the same state update as the selection
   *  itself, instead of this panel guessing it back out via an effect. That used to be two
   *  effects fighting each other — one following the selection's kind, one auto-picking a
   *  default selection whenever the kind didn't match — which could leave the chip rail and
   *  the Timeline's highlighted block disagreeing about what was actually selected. */
  navKind: EffectsNavKind;
  onNavKindChange: (kind: EffectsNavKind) => void;

  effects: TimelineEffect[];
  activeEffectId: string | null;
  onActiveEffectChange: (id: string | null) => void;
  onAddEffect: (kind: TimelineEffectKind) => void;
  onPatchEffect: (id: string, patch: Partial<TimelineEffect>) => void;
  onRemoveEffect: (id: string) => void;

  zooms: TimelineZoom[];
  activeZoomId: string | null;
  onActiveZoomChange: (id: string | null) => void;
  onAddZoom: () => void;
  onSetZoomPct: (id: string, pct: number) => void;
  onSetZoomStyle: (id: string, style: TimelineZoomStyle) => void;
  onSetZoomTilt: (id: string, patch: Partial<TimelineZoomTilt>) => void;
  onRemoveZoom: (id: string) => void;
}

/** The Effects tab — a narrow side nav bar (Zoom, Callout, Blur) picking which block's own
 *  controls the content pane shows, so the three never compete for space the way stacked
 *  cards did. Zoom sits first/top, matching its position on the Timeline (directly above the
 *  Callout/Blur rows). None of the three has a quick-pick grid or free-draw any more — just a
 *  single Add button, the only way any of them ever gets created — and each shows its
 *  existing boxes/blocks as a numbered chip rail exactly like the other two (see
 *  fx-chip-rail below): clicking Add creates one, selects it, and shows its settings
 *  immediately below, same as picking any other chip.
 *
 *  *Where* a Callout/Blur box sits on the frame is set on the preview; *when* any of the
 *  three shows is the Timeline's — each gets its own row there, holding one movable,
 *  edge-trimmable window per block. A further one can also be added by clicking that row's
 *  own empty space directly. */
export function EffectsEditPanel({
  navKind,
  onNavKindChange,
  effects,
  activeEffectId,
  onActiveEffectChange,
  onAddEffect,
  onPatchEffect,
  onRemoveEffect,
  zooms,
  activeZoomId,
  onActiveZoomChange,
  onAddZoom,
  onSetZoomPct,
  onSetZoomStyle,
  onSetZoomTilt,
  onRemoveZoom,
}: EffectsEditPanelProps) {
  const activeEffect = navKind !== "zoom" ? (effects.find((e) => e.id === activeEffectId) ?? null) : null;
  const activeZoom = navKind === "zoom" ? (zooms.find((z) => z.id === activeZoomId) ?? null) : null;

  const navItem = NAV_ITEMS.find((n) => n.kind === navKind)!;
  const mineEffects = navKind !== "zoom" ? effects.filter((e) => e.kind === navKind) : [];
  const chipCount = navKind === "zoom" ? zooms.length : mineEffects.length;

  return (
    <div className="effects-edit-panel">
      <nav className="fx-nav" aria-label="Effect type">
        {NAV_ITEMS.map((n) => {
          const Icon = n.icon;
          const count = n.kind === "zoom" ? zooms.length : effects.filter((e) => e.kind === n.kind).length;
          return (
            <button
              key={n.kind}
              type="button"
              className={`fx-nav-btn fx-nav-btn-${n.kind}${navKind === n.kind ? " active" : ""}`}
              aria-pressed={navKind === n.kind}
              onClick={() => onNavKindChange(n.kind)}
            >
              <Icon size={16} />
              <span className="fx-nav-btn-label">{n.label}</span>
              {count > 0 && <span className="fx-nav-count">{count}</span>}
            </button>
          );
        })}
      </nav>

      <div className="fx-content">
        {/* One rail for all three: every existing box/block as a numbered chip, then Add
            pinned at the end — same pill shape, just its own block color, so it reads as
            "one more of these" rather than a separate control elsewhere on the pane. Always
            rendered, even with zero yet, since Add is the only way to create the first one. */}
        <div className="fx-chip-rail" role="tablist" aria-label={`${navItem.label} boxes`}>
          {navKind === "zoom"
            ? zooms.map((z, i) => (
                <button
                  key={z.id}
                  type="button"
                  role="tab"
                  aria-selected={z.id === activeZoomId}
                  className={`fx-chip${z.id === activeZoomId ? " active" : ""}`}
                  onClick={() => onActiveZoomChange(z.id === activeZoomId ? null : z.id)}
                >
                  Zoom {i + 1}
                </button>
              ))
            : mineEffects.map((e, i) => (
                <button
                  key={e.id}
                  type="button"
                  role="tab"
                  aria-selected={e.id === activeEffectId}
                  className={`fx-chip${e.id === activeEffectId ? " active" : ""}`}
                  onClick={() => onActiveEffectChange(e.id === activeEffectId ? null : e.id)}
                >
                  {navItem.label} {i + 1}
                </button>
              ))}
          <button
            type="button"
            className={`fx-chip fx-chip-add fx-chip-add-${navKind}`}
            onClick={() => (navKind === "zoom" ? onAddZoom() : onAddEffect(navKind))}
            title={`Add ${navItem.label.toLowerCase()}`}
          >
            <Plus size={12} />
            Add
          </button>
        </div>

        {chipCount === 0 && (
          <p className="fx-empty-hint">
            No {navItem.label.toLowerCase()} yet — click Add to create one.
          </p>
        )}

        {navKind === "zoom" && activeZoom && (
          <ZoomSettings
            zoom={activeZoom}
            onSetPct={(pct) => onSetZoomPct(activeZoom.id, pct)}
            onSetStyle={(style) => onSetZoomStyle(activeZoom.id, style)}
            onSetTilt={(patch) => onSetZoomTilt(activeZoom.id, patch)}
            onRemove={() => onRemoveZoom(activeZoom.id)}
          />
        )}

        {navKind !== "zoom" && activeEffect && (
          <EffectSettings
            effect={activeEffect}
            onPatch={(patch) => onPatchEffect(activeEffect.id, patch)}
            onRemove={() => onRemoveEffect(activeEffect.id)}
          />
        )}
      </div>
    </div>
  );
}
