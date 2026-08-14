import { dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Channels } from "@shared/constants/channels";
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
import { defaultLlmConfig } from "@shared/constants/llmDefaults";
import { getSaveDir, setSaveDir } from "../native/paths";
import {
  listLlmProfiles,
  saveLlmProfile,
  deleteLlmProfile,
  getRecordSettings,
  setRecordSettings,
  getMeetingSettings,
  setMeetingSettings,
  getWhisperModel,
  setWhisperModel,
  getUseDoculigentModel,
  setUseDoculigentModel,
  getTranscriptionByokProfileId,
  setTranscriptionByokProfileId,
  getAutoTranscribeSettings,
  setAutoTranscribeSettings,
} from "../native/settingsStore";
import { setLlmApiKey, deleteLlmApiKey } from "../native/keyring";
import { preloadWhisperModel } from "../transcription/whisper";
import { deleteWhisperModelCache, getWhisperModelStatuses, whisperCacheDir } from "../transcription/modelCache";

export function registerSettingsIpc(): void {
  ipcMain.handle(Channels.settings.getSaveDir, async (): Promise<string> => getSaveDir());

  ipcMain.handle(Channels.settings.setSaveDir, async (_event, dir: string): Promise<void> => {
    setSaveDir(dir);
  });

  ipcMain.handle(Channels.settings.pickSaveDir, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      defaultPath: getSaveDir(),
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(Channels.settings.showItemInFolder, async (_event, filePath: string): Promise<void> => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle(Channels.settings.listLlmProfiles, async (): Promise<LlmModelProfile[]> => listLlmProfiles());

  ipcMain.handle(
    Channels.settings.saveLlmProfile,
    async (_event, profile: LlmModelProfile, apiKey?: string | null): Promise<void> => {
      if (apiKey) await setLlmApiKey(profile.id, apiKey);
      saveLlmProfile(profile);
    }
  );

  ipcMain.handle(Channels.settings.deleteLlmProfile, async (_event, id: string): Promise<void> => {
    await deleteLlmApiKey(id);
    deleteLlmProfile(id);
  });

  ipcMain.handle(
    Channels.settings.defaultProfileTemplate,
    async (_event, kind: LlmProviderKind): Promise<LlmModelProfile> => ({
      id: randomUUID(),
      name: "",
      ...defaultLlmConfig(kind),
    })
  );

  ipcMain.handle(
    Channels.settings.getRecordSettings,
    async (): Promise<{
      overlay: OverlayConfig | null;
      targetId: string | null;
      mic: MicConfig | null;
      systemAudio: SystemAudioConfig | null;
      captureMode: CaptureMode | null;
      areaRect: AreaRect | null;
    }> => getRecordSettings()
  );

  ipcMain.handle(
    Channels.settings.setRecordSettings,
    async (
      _event,
      overlay: OverlayConfig,
      targetId: string | null,
      mic: MicConfig | null,
      systemAudio: SystemAudioConfig | null,
      captureMode: CaptureMode | null,
      areaRect: AreaRect | null
    ): Promise<void> => {
      setRecordSettings(overlay, targetId, mic, systemAudio, captureMode, areaRect);
    }
  );

  ipcMain.handle(
    Channels.settings.getMeetingSettings,
    async (): Promise<{
      language: string | null;
      micEnabled: boolean | null;
      micDeviceId: string | null;
      systemAudioEnabled: boolean | null;
      systemAudioSourceId: string | null;
    }> => getMeetingSettings()
  );

  ipcMain.handle(
    Channels.settings.setMeetingSettings,
    async (
      _event,
      language: string,
      micEnabled: boolean,
      micDeviceId: string | null,
      systemAudioEnabled: boolean,
      systemAudioSourceId: string | null
    ): Promise<void> => {
      setMeetingSettings(language, micEnabled, micDeviceId, systemAudioEnabled, systemAudioSourceId);
    }
  );

  ipcMain.handle(Channels.settings.getWhisperModel, async (): Promise<WhisperModelSize | null> => getWhisperModel());

  ipcMain.handle(Channels.settings.setWhisperModel, async (_event, size: WhisperModelSize | null): Promise<void> => {
    setWhisperModel(size);
  });

  ipcMain.handle(
    Channels.settings.getWhisperModelStatuses,
    async (): Promise<WhisperModelStatus[]> => getWhisperModelStatuses()
  );

  ipcMain.handle(Channels.settings.downloadWhisperModel, async (_event, size: WhisperModelSize): Promise<void> => {
    await preloadWhisperModel(size);
  });

  ipcMain.handle(Channels.settings.deleteWhisperModel, async (_event, size: WhisperModelSize): Promise<void> => {
    deleteWhisperModelCache(size);
    if (getWhisperModel() === size) setWhisperModel(null);
  });

  ipcMain.handle(Channels.settings.getWhisperModelsDir, async (): Promise<string> => whisperCacheDir());

  ipcMain.handle(Channels.settings.openWhisperModelsDir, async (): Promise<void> => {
    const dir = whisperCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle(Channels.settings.getUseDoculigentModel, async (): Promise<boolean> => getUseDoculigentModel());

  ipcMain.handle(Channels.settings.setUseDoculigentModel, async (_event, use: boolean): Promise<void> => {
    setUseDoculigentModel(use);
  });

  ipcMain.handle(
    Channels.settings.getTranscriptionByokProfileId,
    async (): Promise<string | null> => getTranscriptionByokProfileId()
  );

  ipcMain.handle(Channels.settings.setTranscriptionByokProfileId, async (_event, id: string | null): Promise<void> => {
    setTranscriptionByokProfileId(id);
  });

  ipcMain.handle(
    Channels.settings.getAutoTranscribeSettings,
    async (): Promise<AutoTranscribeSettings> => getAutoTranscribeSettings()
  );

  ipcMain.handle(
    Channels.settings.setAutoTranscribeSettings,
    async (_event, settings: AutoTranscribeSettings): Promise<void> => {
      setAutoTranscribeSettings(settings);
    }
  );
}
