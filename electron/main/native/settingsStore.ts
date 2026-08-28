
import fs from "node:fs";
import path from "node:path";
import type {
  AreaRect,
  AutoTranscribeSettings,
  CameraBubbleBounds,
  CameraBubbleConfig,
  CaptureMode,
  LlmModelProfile,
  MicConfig,
  OverlayConfig,
  RecordingDockBounds,
  RecordingDockConfig,
  SystemAudioConfig,
} from "@shared/types/models";
import type { ProjectManager } from "@shared/types/projectManager";
import type { CustomPersona } from "@shared/types/persona";
import type { AuthUser } from "@shared/types/auth";
import type { WhisperModelSize } from "@shared/constants/whisperModels";
import type { StoragePreference } from "@shared/types/storage";
import { settingsFilePath } from "./paths";

export interface GoogleDriveAccount {
  email: string;
}

interface StoredSettings {
  llmProfiles?: LlmModelProfile[];
  projectManagers?: ProjectManager[];
  customPersonas?: CustomPersona[];
  authUser?: AuthUser;
  authExpiresAt?: string | null;
  recordOverlay?: OverlayConfig;
  recordTargetId?: string | null;
  recordMic?: MicConfig;
  recordSystemAudio?: SystemAudioConfig;
  recordCaptureMode?: CaptureMode;
  recordAreaRect?: AreaRect;
  recordCountdownSecs?: number;
  recordingMode?: "quick" | "advanced";
  meetingLanguage?: string;
  meetingMicEnabled?: boolean;
  meetingMicDeviceId?: string | null;
  meetingSystemAudioEnabled?: boolean;
  meetingSystemAudioSourceId?: string | null;
  whisperModel?: WhisperModelSize | null;
  useDoculigentModel?: boolean;
  transcriptionByokProfileId?: string | null;
  autoTranscribe?: AutoTranscribeSettings;
  storagePreference?: StoragePreference;
  googleDriveAccount?: GoogleDriveAccount;
  cameraBubbleConfig?: CameraBubbleConfig;
  cameraBubbleBounds?: CameraBubbleBounds;
  recordingDockConfig?: RecordingDockConfig;
  recordingDockBounds?: RecordingDockBounds;
}

const DEFAULT_STORAGE_PREFERENCE: StoragePreference = { provider: "doculigent" };

const DEFAULT_AUTO_TRANSCRIBE: AutoTranscribeSettings = {
  all: true,
  recording: true,
  videoImport: true,
  audioImport: true,
  teamsContent: true,
};

function readStored(): StoredSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsFilePath(), "utf-8")) as StoredSettings;
  } catch {
    return {};
  }
}

function writeStored(settings: StoredSettings): void {
  const file = settingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

export function listLlmProfiles(): LlmModelProfile[] {
  const profiles = readStored().llmProfiles ?? [];
  return profiles.map((p) => (p.capabilities ? p : { ...p, capabilities: ["chat"] }));
}

export function getLlmProfile(id: string): LlmModelProfile | null {
  return listLlmProfiles().find((p) => p.id === id) ?? null;
}

export function saveLlmProfile(profile: LlmModelProfile): void {
  const stored = readStored();
  const existing = stored.llmProfiles ?? [];
  const idx = existing.findIndex((p) => p.id === profile.id);
  const llmProfiles = idx >= 0 ? existing.map((p, i) => (i === idx ? profile : p)) : [...existing, profile];
  writeStored({ ...stored, llmProfiles });
}

export function deleteLlmProfile(id: string): void {
  const stored = readStored();
  const llmProfiles = (stored.llmProfiles ?? []).filter((p) => p.id !== id);
  const transcriptionByokProfileId =
    stored.transcriptionByokProfileId === id ? null : stored.transcriptionByokProfileId;
  writeStored({ ...stored, llmProfiles, transcriptionByokProfileId });
}

export function listProjectManagers(): ProjectManager[] {
  return readStored().projectManagers ?? [];
}

export function getProjectManager(id: string): ProjectManager | null {
  return listProjectManagers().find((pm) => pm.id === id) ?? null;
}

export function saveProjectManager(pm: ProjectManager): void {
  const stored = readStored();
  const existing = stored.projectManagers ?? [];
  const idx = existing.findIndex((p) => p.id === pm.id);
  const projectManagers = idx >= 0 ? existing.map((p, i) => (i === idx ? pm : p)) : [...existing, pm];
  writeStored({ ...stored, projectManagers });
}

export function deleteProjectManager(id: string): void {
  const stored = readStored();
  const projectManagers = (stored.projectManagers ?? []).filter((p) => p.id !== id);
  writeStored({ ...stored, projectManagers });
}

export function listCustomPersonas(): CustomPersona[] {
  return readStored().customPersonas ?? [];
}

export function saveCustomPersona(persona: CustomPersona): void {
  const stored = readStored();
  const existing = stored.customPersonas ?? [];
  const idx = existing.findIndex((p) => p.id === persona.id);
  const customPersonas = idx >= 0 ? existing.map((p, i) => (i === idx ? persona : p)) : [...existing, persona];
  writeStored({ ...stored, customPersonas });
}

export function deleteCustomPersona(id: string): void {
  const stored = readStored();
  const customPersonas = (stored.customPersonas ?? []).filter((p) => p.id !== id);
  writeStored({ ...stored, customPersonas });
}

export function getAuthProfile(): { user: AuthUser; expiresAt: string | null } | null {
  const stored = readStored();
  if (!stored.authUser) return null;
  const user: AuthUser = { ...stored.authUser, plan: stored.authUser.plan ?? null };
  return { user, expiresAt: stored.authExpiresAt ?? null };
}

export function setAuthProfile(user: AuthUser, expiresAt: string | null): void {
  writeStored({ ...readStored(), authUser: user, authExpiresAt: expiresAt });
}

export function clearAuthProfile(): void {
  const { authUser: _authUser, authExpiresAt: _authExpiresAt, ...rest } = readStored();
  writeStored(rest);
}

export function getRecordSettings(): {
  overlay: OverlayConfig | null;
  targetId: string | null;
  mic: MicConfig | null;
  systemAudio: SystemAudioConfig | null;
  captureMode: CaptureMode | null;
  areaRect: AreaRect | null;
  countdownSecs: number | null;
  recordingMode: "quick" | "advanced" | null;
} {
  const stored = readStored();
  return {
    overlay: stored.recordOverlay ?? null,
    targetId: stored.recordTargetId ?? null,
    mic: stored.recordMic ?? null,
    systemAudio: stored.recordSystemAudio ?? null,
    captureMode: stored.recordCaptureMode ?? null,
    areaRect: stored.recordAreaRect ?? null,
    countdownSecs: stored.recordCountdownSecs ?? null,
    recordingMode: stored.recordingMode ?? null,
  };
}

export function setRecordSettings(
  overlay: OverlayConfig,
  targetId: string | null,
  mic: MicConfig | null,
  systemAudio: SystemAudioConfig | null,
  captureMode: CaptureMode | null,
  areaRect: AreaRect | null,
  countdownSecs: number | null,
  recordingMode: "quick" | "advanced" | null
): void {
  writeStored({
    ...readStored(),
    recordOverlay: overlay,
    recordTargetId: targetId,
    recordMic: mic ?? undefined,
    recordSystemAudio: systemAudio ?? undefined,
    recordCaptureMode: captureMode ?? undefined,
    recordAreaRect: areaRect ?? undefined,
    recordCountdownSecs: countdownSecs ?? undefined,
    recordingMode: recordingMode ?? undefined,
  });
}

export function getMeetingSettings(): {
  language: string | null;
  micEnabled: boolean | null;
  micDeviceId: string | null;
  systemAudioEnabled: boolean | null;
  systemAudioSourceId: string | null;
} {
  const stored = readStored();
  return {
    language: stored.meetingLanguage ?? null,
    micEnabled: stored.meetingMicEnabled ?? null,
    micDeviceId: stored.meetingMicDeviceId ?? null,
    systemAudioEnabled: stored.meetingSystemAudioEnabled ?? null,
    systemAudioSourceId: stored.meetingSystemAudioSourceId ?? null,
  };
}

export function setMeetingSettings(
  language: string,
  micEnabled: boolean,
  micDeviceId: string | null,
  systemAudioEnabled: boolean,
  systemAudioSourceId: string | null
): void {
  writeStored({
    ...readStored(),
    meetingLanguage: language,
    meetingMicEnabled: micEnabled,
    meetingMicDeviceId: micDeviceId,
    meetingSystemAudioEnabled: systemAudioEnabled,
    meetingSystemAudioSourceId: systemAudioSourceId,
  });
}

export function getCameraBubbleState(): { config: CameraBubbleConfig | null; bounds: CameraBubbleBounds | null } {
  const stored = readStored();
  return {
    config: stored.cameraBubbleConfig ?? null,
    bounds: stored.cameraBubbleBounds ?? null,
  };
}

export function setCameraBubbleState(config: CameraBubbleConfig, bounds: CameraBubbleBounds | null): void {
  writeStored({ ...readStored(), cameraBubbleConfig: config, cameraBubbleBounds: bounds ?? undefined });
}

export function getRecordingDockState(): { config: RecordingDockConfig | null; bounds: RecordingDockBounds | null } {
  const stored = readStored();
  return {
    config: stored.recordingDockConfig ?? null,
    bounds: stored.recordingDockBounds ?? null,
  };
}

export function setRecordingDockState(config: RecordingDockConfig, bounds: RecordingDockBounds | null): void {
  writeStored({ ...readStored(), recordingDockConfig: config, recordingDockBounds: bounds ?? undefined });
}

export function getWhisperModel(): WhisperModelSize | null {
  return readStored().whisperModel ?? null;
}

export function setWhisperModel(size: WhisperModelSize | null): void {
  writeStored({ ...readStored(), whisperModel: size });
}

export function getUseDoculigentModel(): boolean {
  return !!readStored().useDoculigentModel;
}

export function setUseDoculigentModel(use: boolean): void {
  writeStored({ ...readStored(), useDoculigentModel: use });
}

export function getTranscriptionByokProfileId(): string | null {
  return readStored().transcriptionByokProfileId ?? null;
}

export function setTranscriptionByokProfileId(id: string | null): void {
  writeStored({ ...readStored(), transcriptionByokProfileId: id });
}

export function getAutoTranscribeSettings(): AutoTranscribeSettings {
  return { ...DEFAULT_AUTO_TRANSCRIBE, ...readStored().autoTranscribe };
}

export function setAutoTranscribeSettings(settings: AutoTranscribeSettings): void {
  writeStored({ ...readStored(), autoTranscribe: settings });
}

export function getStoragePreference(): StoragePreference {
  return readStored().storagePreference ?? DEFAULT_STORAGE_PREFERENCE;
}

export function setStoragePreference(preference: StoragePreference): void {
  writeStored({ ...readStored(), storagePreference: preference });
}

export function getGoogleDriveAccount(): GoogleDriveAccount | null {
  return readStored().googleDriveAccount ?? null;
}

export function setGoogleDriveAccount(account: GoogleDriveAccount): void {
  writeStored({ ...readStored(), googleDriveAccount: account });
}

export function clearGoogleDriveAccount(): void {
  const { googleDriveAccount: _googleDriveAccount, ...rest } = readStored();
  writeStored(rest);
}

