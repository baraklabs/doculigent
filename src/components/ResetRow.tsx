import { RotateCcw, History } from "lucide-react";
import "./ResetRow.css";

interface ResetRowProps {
  /** This tab only, back to how it was recorded (or its own default, for tabs with no
   *  record-time equivalent). */
  onResetOriginal: () => void;
  /** This tab only, back to the app's generic preset. */
  onResetDefault: () => void;
  /** Every tab at once, back to "as recorded". */
  onResetAllToOriginal: () => void;
  /** Every tab at once, back to the app's generic presets. */
  onResetAllToDefault: () => void;
}

export function ResetRow({ onResetOriginal, onResetDefault, onResetAllToOriginal, onResetAllToDefault }: ResetRowProps) {
  return (
    <div className="reset-row">
      <div className="reset-row-group">
        <button type="button" className="reset-row-btn is-original" onClick={onResetOriginal}>
          <RotateCcw size={13} />
          Reset to original
        </button>
        <button type="button" className="reset-row-btn is-default" onClick={onResetDefault}>
          <RotateCcw size={13} />
          Reset to default
        </button>
      </div>
      <div className="reset-row-group">
        <button
          type="button"
          className="reset-row-icon-btn is-original"
          title="Reset all tabs to original"
          aria-label="Reset all tabs to original"
          onClick={onResetAllToOriginal}
        >
          <History size={14} />
        </button>
        <button
          type="button"
          className="reset-row-icon-btn is-default"
          title="Reset all tabs to default"
          aria-label="Reset all tabs to default"
          onClick={onResetAllToDefault}
        >
          <RotateCcw size={14} />
        </button>
      </div>
    </div>
  );
}
