import type {
  AreaRect,
  AutoTranscribeSettings,
  CaptureMode,
  LlmModelProfile,
  LlmProviderKind,
  MicConfig,
  OverlayConfig,
  SystemAudioConfig,
} from "@shared/types/models";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";

export const SettingsService = {
  getSaveDir(): Promise<string> {
    return window.api.settings.getSaveDir();
  },
  setSaveDir(dir: string): Promise<void> {
    return window.api.settings.setSaveDir(dir);
  },
  pickSaveDir(): Promise<string | null> {
    return window.api.settings.pickSaveDir();
  },
  showItemInFolder(filePath: string): Promise<void> {
    return window.api.settings.showItemInFolder(filePath);
  },
  listLlmProfiles(): Promise<LlmModelProfile[]> {
    return window.api.settings.listLlmProfiles();
  },
  saveLlmProfile(profile: LlmModelProfile, apiKey?: string | null): Promise<void> {
    return window.api.settings.saveLlmProfile(profile, apiKey);
  },
  deleteLlmProfile(id: string): Promise<void> {
    return window.api.settings.deleteLlmProfile(id);
  },
  defaultProfileTemplate(kind: LlmProviderKind): Promise<LlmModelProfile> {
    return window.api.settings.defaultProfileTemplate(kind);
  },
  getRecordSettings(): Promise<{
    overlay: OverlayConfig | null;
    targetId: string | null;
    mic: MicConfig | null;
    systemAudio: SystemAudioConfig | null;
    captureMode: CaptureMode | null;
    areaRect: AreaRect | null;
  }> {
    return window.api.settings.getRecordSettings();
  },
  setRecordSettings(
    overlay: OverlayConfig,
    targetId: string | null,
    mic: MicConfig | null,
    systemAudio: SystemAudioConfig | null,
    captureMode: CaptureMode | null,
    areaRect: AreaRect | null
  ): Promise<void> {
    return window.api.settings.setRecordSettings(overlay, targetId, mic, systemAudio, captureMode, areaRect);
  },
  getMeetingSettings(): Promise<{
    language: string | null;
    micEnabled: boolean | null;
    micDeviceId: string | null;
    systemAudioEnabled: boolean | null;
    systemAudioSourceId: string | null;
  }> {
    return window.api.settings.getMeetingSettings();
  },
  setMeetingSettings(
    language: string,
    micEnabled: boolean,
    micDeviceId: string | null,
    systemAudioEnabled: boolean,
    systemAudioSourceId: string | null
  ): Promise<void> {
    return window.api.settings.setMeetingSettings(language, micEnabled, micDeviceId, systemAudioEnabled, systemAudioSourceId);
  },
  getWhisperModel(): Promise<WhisperModelSize | null> {
    return window.api.settings.getWhisperModel();
  },
  setWhisperModel(size: WhisperModelSize | null): Promise<void> {
    return window.api.settings.setWhisperModel(size);
  },
  getWhisperModelStatuses(): Promise<WhisperModelStatus[]> {
    return window.api.settings.getWhisperModelStatuses();
  },
  downloadWhisperModel(size: WhisperModelSize): Promise<void> {
    return window.api.settings.downloadWhisperModel(size);
  },
  deleteWhisperModel(size: WhisperModelSize): Promise<void> {
    return window.api.settings.deleteWhisperModel(size);
  },
  getWhisperModelsDir(): Promise<string> {
    return window.api.settings.getWhisperModelsDir();
  },
  openWhisperModelsDir(): Promise<void> {
    return window.api.settings.openWhisperModelsDir();
  },
  getUseDoculigentModel(): Promise<boolean> {
    return window.api.settings.getUseDoculigentModel();
  },
  setUseDoculigentModel(use: boolean): Promise<void> {
    return window.api.settings.setUseDoculigentModel(use);
  },
  getTranscriptionByokProfileId(): Promise<string | null> {
    return window.api.settings.getTranscriptionByokProfileId();
  },
  setTranscriptionByokProfileId(id: string | null): Promise<void> {
    return window.api.settings.setTranscriptionByokProfileId(id);
  },
  getAutoTranscribeSettings(): Promise<AutoTranscribeSettings> {
    return window.api.settings.getAutoTranscribeSettings();
  },
  setAutoTranscribeSettings(settings: AutoTranscribeSettings): Promise<void> {
    return window.api.settings.setAutoTranscribeSettings(settings);
  },
};
