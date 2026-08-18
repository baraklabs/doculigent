import { Volume2, VolumeX } from "lucide-react";
import { DEFAULT_SOUND_EDIT_SETTINGS, type SoundEditSettings } from "@shared/types/models";
import { ResetRow } from "./ResetRow";
import "./SoundEditPanel.css";

interface SoundEditPanelProps {
  sound: SoundEditSettings;
  onChange: (next: SoundEditSettings) => void;
  onResetAllToOriginal: () => void;
  onResetAllToDefault: () => void;
}

export function SoundEditPanel({ sound, onChange, onResetAllToOriginal, onResetAllToDefault }: SoundEditPanelProps) {
  function patch(partial: Partial<SoundEditSettings>) {
    onChange({ ...sound, ...partial });
  }

  return (
    <div className="sound-edit-panel">
      <div className="sound-edit-section">
        <span className="sound-edit-label">Audio</span>
        <button
          type="button"
          className={`sound-mute-row${sound.muted ? " active" : ""}`}
          aria-pressed={sound.muted}
          onClick={() => patch({ muted: !sound.muted })}
        >
          <span className="sound-mute-icon">{sound.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</span>
          <span className="sound-mute-copy">
            <span className="sound-mute-title">Mute audio</span>
            <span className="sound-mute-subtitle">Removes audio and speech from the recorded video.</span>
          </span>
          <span className="sound-mute-switch" data-on={sound.muted} />
        </button>
      </div>

      <ResetRow
        onResetOriginal={() => onChange(DEFAULT_SOUND_EDIT_SETTINGS)}
        onResetDefault={() => onChange(DEFAULT_SOUND_EDIT_SETTINGS)}
        onResetAllToOriginal={onResetAllToOriginal}
        onResetAllToDefault={onResetAllToDefault}
      />
    </div>
  );
}
