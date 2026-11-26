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
import { CACHE_KEYS, loadCached, putCache } from "../../lib/settingsCache";

export const SettingsService = {
  getRecordingsDir(): Promise<string> {
    return loadCached(CACHE_KEYS.recordingsDir, () => window.api.settings.getRecordingsDir());
  },
  setRecordingsDir(dir: string): Promise<void> {
    putCache(CACHE_KEYS.recordingsDir, dir);
    return window.api.settings.setRecordingsDir(dir);
  },
  pickRecordingsDir(): Promise<string | null> {
    return window.api.settings.pickRecordingsDir();
  },
  getMeetingsDir(): Promise<string> {
    return window.api.settings.getMeetingsDir();
  },
  setMeetingsDir(dir: string): Promise<void> {
    return window.api.settings.setMeetingsDir(dir);
  },
  pickMeetingsDir(): Promise<string | null> {
    return window.api.settings.pickMeetingsDir();
  },
  getProjectsDir(): Promise<string> {
    return window.api.settings.getProjectsDir();
  },
  setProjectsDir(dir: string): Promise<void> {
    return window.api.settings.setProjectsDir(dir);
  },
  pickProjectsDir(): Promise<string | null> {
    return window.api.settings.pickProjectsDir();
  },
  getTeamsDir(): Promise<string> {
    return window.api.settings.getTeamsDir();
  },
  setTeamsDir(dir: string): Promise<void> {
    return window.api.settings.setTeamsDir(dir);
  },
  pickTeamsDir(): Promise<string | null> {
    return window.api.settings.pickTeamsDir();
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
    countdownSecs: number | null;
    recordingMode: "quick" | "advanced" | null;
  }> {
    return loadCached(CACHE_KEYS.record, () => window.api.settings.getRecordSettings());
  },
  setRecordSettings(
    overlay: OverlayConfig,
    targetId: string | null,
    mic: MicConfig | null,
    systemAudio: SystemAudioConfig | null,
    captureMode: CaptureMode | null,
    areaRect: AreaRect | null,
    countdownSecs: number | null,
    recordingMode: "quick" | "advanced" | null
  ): Promise<void> {
    putCache(CACHE_KEYS.record, { overlay, targetId, mic, systemAudio, captureMode, areaRect, countdownSecs, recordingMode });
    return window.api.settings.setRecordSettings(
      overlay,
      targetId,
      mic,
      systemAudio,
      captureMode,
      areaRect,
      countdownSecs,
      recordingMode
    );
  },
  getMeetingSettings(): Promise<{
    language: string | null;
    micEnabled: boolean | null;
    micDeviceId: string | null;
    systemAudioEnabled: boolean | null;
    systemAudioSourceId: string | null;
  }> {
    return loadCached(CACHE_KEYS.meeting, () => window.api.settings.getMeetingSettings());
  },
  setMeetingSettings(
    language: string,
    micEnabled: boolean,
    micDeviceId: string | null,
    systemAudioEnabled: boolean,
    systemAudioSourceId: string | null
  ): Promise<void> {
    putCache(CACHE_KEYS.meeting, {
      language,
      micEnabled,
      micDeviceId,
      systemAudioEnabled,
      systemAudioSourceId,
    });
    return window.api.settings.setMeetingSettings(language, micEnabled, micDeviceId, systemAudioEnabled, systemAudioSourceId);
  },
  getWhisperModel(): Promise<WhisperModelSize | null> {
    return window.api.settings.getWhisperModel();
  },
  setWhisperModel(size: WhisperModelSize | null): Promise<void> {
    return window.api.settings.setWhisperModel(size);
  },
  getWhisperModelStatuses(): Promise<WhisperModelStatus[]> {
    return loadCached(CACHE_KEYS.whisperStatuses, () => window.api.settings.getWhisperModelStatuses());
  },
  downloadWhisperModel(size: WhisperModelSize): Promise<void> {
    return window.api.settings.downloadWhisperModel(size);
  },
  deleteWhisperModel(size: WhisperModelSize): Promise<void> {
    return window.api.settings.deleteWhisperModel(size);
  },
  getWhisperModelsDir(): Promise<string> {
    return loadCached(CACHE_KEYS.whisperDir, () => window.api.settings.getWhisperModelsDir());
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
  getTelemetryState(): Promise<{ enabled: boolean; noticeSeen: boolean; installId: string | null }> {
    return window.api.settings.getTelemetryState();
  },
  setTelemetryEnabled(enabled: boolean): Promise<void> {
    return window.api.settings.setTelemetryEnabled(enabled);
  },
  markTelemetryNoticeSeen(): Promise<void> {
    return window.api.settings.markTelemetryNoticeSeen();
  },
};
