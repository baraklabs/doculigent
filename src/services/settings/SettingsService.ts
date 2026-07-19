import type { LlmModelProfile, LlmProviderKind, MicConfig, OverlayConfig } from "@shared/types/models";
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
  getActiveLlmProfileId(): Promise<string | null> {
    return window.api.settings.getActiveLlmProfileId();
  },
  saveLlmProfile(profile: LlmModelProfile, apiKey?: string | null): Promise<void> {
    return window.api.settings.saveLlmProfile(profile, apiKey);
  },
  deleteLlmProfile(id: string): Promise<void> {
    return window.api.settings.deleteLlmProfile(id);
  },
  setActiveLlmProfile(id: string): Promise<void> {
    return window.api.settings.setActiveLlmProfile(id);
  },
  defaultProfileTemplate(kind: LlmProviderKind): Promise<LlmModelProfile> {
    return window.api.settings.defaultProfileTemplate(kind);
  },
  getRecordSettings(): Promise<{ overlay: OverlayConfig | null; targetId: string | null; mic: MicConfig | null }> {
    return window.api.settings.getRecordSettings();
  },
  setRecordSettings(overlay: OverlayConfig, targetId: string | null, mic: MicConfig | null): Promise<void> {
    return window.api.settings.setRecordSettings(overlay, targetId, mic);
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
  getWhisperModel(): Promise<WhisperModelSize> {
    return window.api.settings.getWhisperModel();
  },
  setWhisperModel(size: WhisperModelSize): Promise<void> {
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
};
