import { RotateCcw } from "lucide-react";
import "./CutChipRail.css";

export const MASTER_CUT_ID = "__master";

export interface CutChipRailCut {
  id: string;
  label: string;
  hasOverride: boolean;
}

interface CutChipRailProps {
  /** false only for the Zoom Effect panel — zoom blocks have no shared master to fall
   *  back to, each one just is its own config. */
  showMaster: boolean;
  /** Excludes the master chip — pass every real cut/segment/zoom for the active track. */
  cuts: CutChipRailCut[];
  /** MASTER_CUT_ID, or one of `cuts`' own ids. */
  activeId: string;
  onSelect: (id: string) => void;
  /** Reverts the active cut's own override back to inheriting Main. Shown only while a
   *  real (non-master) cut with an override is selected. */
  onClearOverride?: () => void;
}

/** The "scrollable small rectangle" — a horizontally-scrolling pill row listing Main first
 *  (unless `showMaster` is false), then every cut/segment/zoom for whichever track's panel
 *  is open. Selecting a chip is the only way to view/edit a specific cut's settings —
 *  creating a new cut still goes through the Timeline's own Cut tool (see CutChipRail.css's
 *  own comment on why there's no "+" button here). The empty-state hint and the "Reset to
 *  Main" button live *outside* the scrolling row itself (in `.cut-chip-rail-wrap`) so they
 *  can wrap onto their own line on a narrow sidebar instead of competing with the chips for
 *  width inside a `white-space: nowrap` flex row and getting visually clipped. */
export function CutChipRail({ showMaster, cuts, activeId, onSelect, onClearOverride }: CutChipRailProps) {
  if (!showMaster && cuts.length === 0) {
    return <div className="cut-chip-rail cut-chip-rail-empty">Click the Zoom track below to add a zoom effect</div>;
  }
  const activeCut = cuts.find((c) => c.id === activeId);
  return (
    <div className="cut-chip-rail-wrap">
      <div className="cut-chip-rail" role="tablist" aria-label="Main/cut selector">
        {showMaster && (
          <button
            type="button"
            role="tab"
            aria-selected={activeId === MASTER_CUT_ID}
            className={`cut-chip${activeId === MASTER_CUT_ID ? " active" : ""}`}
            onClick={() => onSelect(MASTER_CUT_ID)}
          >
            Main
          </button>
        )}
        {cuts.map((cut) => (
          <button
            key={cut.id}
            type="button"
            role="tab"
            aria-selected={activeId === cut.id}
            className={`cut-chip${activeId === cut.id ? " active" : ""}`}
            onClick={() => onSelect(cut.id)}
            title={cut.hasOverride ? `${cut.label} — customized, overrides Main` : `${cut.label} — inherits Main`}
          >
            {cut.label}
            {cut.hasOverride && <span className="cut-chip-dot" />}
          </button>
        ))}
      </div>
      {showMaster && cuts.length === 0 && (
        <span className="cut-chip-hint">Use the Cut tool on the Timeline to add a cut</span>
      )}
      {showMaster && activeId !== MASTER_CUT_ID && activeCut?.hasOverride && onClearOverride && (
        <button type="button" className="cut-chip-clear-btn" onClick={onClearOverride} title="Discard this cut's own settings — it goes back to inheriting Main">
          <RotateCcw size={11} />
          Reset to Main
        </button>
      )}
    </div>
  );
}
