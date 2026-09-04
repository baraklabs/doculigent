import { ComingSoon } from "./ComingSoon";
import { CutChipRail, type CutChipRailCut } from "./CutChipRail";
import "./ExtSoundEditPanel.css";

interface ExtSoundEditPanelProps {
  /** One chip per piece on the Ext Audio track (see EditPage's clipCuts). Selection-only
   *  for now — it scrolls the Timeline to that piece and seeks to it, the same as every
   *  other tab's rail, but there are no per-cut settings to show yet, so no chip ever
   *  carries an override dot. */
  cuts: CutChipRailCut[];
  activeCutId: string;
  onActiveCutChange: (id: string) => void;
  /** True while the track has nothing placed on it at all. */
  empty: boolean;
}

/** The Ext Sound tab — the cut rail for added audio, plus a placeholder for the
 *  enhancement controls (noise removal, leveling, speech enhancement) that will hang off
 *  it. Everything an added audio piece *can* be edited by today — where it sits, how it's
 *  trimmed, whether it's there at all — is a Timeline gesture, so the rail is deliberately
 *  read-only here rather than duplicating those controls. */
export function ExtSoundEditPanel({ cuts, activeCutId, onActiveCutChange, empty }: ExtSoundEditPanelProps) {
  return (
    <div className="ext-sound-edit-panel">
      <CutChipRail showMaster cuts={cuts} activeId={activeCutId} onSelect={onActiveCutChange} />

      {empty && (
        <p className="ext-sound-empty-hint">
          Nothing on the Ext Sound track yet — add an audio file from the Media panel, then
          drag it onto the track.
        </p>
      )}

      <ComingSoon
        icon="🎚️"
        title="Enhancement"
        subtitle="Noise removal, loudness leveling and speech enhancement for added audio."
      />
    </div>
  );
}
