/** LLM model profiles + app settings, persisted as JSON in the app's userData dir (see
 *  paths.ts). API keys are NOT stored here — see keyring.ts. */
import fs from "node:fs";
import path from "node:path";
import type { LlmModelProfile, MicConfig, OverlayConfig } from "@shared/types/models";
import type { AuthUser } from "@shared/types/auth";
import type { WhisperModelSize } from "@shared/constants/whisperModels";
import { DEFAULT_WHISPER_MODEL } from "@shared/constants/whisperModels";
import { settingsFilePath } from "./paths";

interface StoredSettings {
  llmProfiles?: LlmModelProfile[];
  activeLlmProfileId?: string | null;
  authUser?: AuthUser;
  authExpiresAt?: string | null;
  recordOverlay?: OverlayConfig;
  recordTargetId?: string | null;
  recordMic?: MicConfig;
  /** Last-used Meeting tab settings — same restore-on-reopen idea as recordOverlay/
   *  recordTargetId/recordMic above, just for the Meeting tab's own fields. Title isn't
   *  included, matching the Record tab (title always starts fresh, everything else
   *  sticks). */
  meetingLanguage?: string;
  meetingMicEnabled?: boolean;
  meetingMicDeviceId?: string | null;
  meetingSystemAudioEnabled?: boolean;
  meetingSystemAudioSourceId?: string | null;
  /** Which local Whisper model size to transcribe with (see whisper.ts) — bigger sizes
   *  are more accurate, especially for non-English languages, at the cost of a larger
   *  download and slower per-chunk inference. */
  whisperModel?: WhisperModelSize;
  /** Set right before systemCursor.ts swaps the real OS cursor, cleared once it's put
   *  back — a marker so a crash mid-recording can still be cleaned up on next launch
   *  (see systemCursor.ts's restorePendingCursorOverride). Just a boolean: restoring
   *  always means the same thing (reload the real scheme from registry), so there's
   *  nothing else worth remembering about what was overridden. */
  cursorOverride?: boolean;
}

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
  // Profiles saved before LlmCapability existed (see shared/types/models.ts) have no
  // `capabilities` field in settings.json at all — every profile was implicitly chat-only
  // back then, so that's the correct default for old data read from disk.
  return profiles.map((p) => (p.capabilities ? p : { ...p, capabilities: ["chat"] }));
}

export function getActiveLlmProfileId(): string | null {
  const profiles = listLlmProfiles();
  const stored = readStored();
  if (stored.activeLlmProfileId && profiles.some((p) => p.id === stored.activeLlmProfileId)) {
    return stored.activeLlmProfileId;
  }
  return profiles[0]?.id ?? null;
}

export function getActiveLlmProfile(): LlmModelProfile | null {
  const profiles = listLlmProfiles();
  const activeId = getActiveLlmProfileId();
  return profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
}

export function getLlmProfile(id: string): LlmModelProfile | null {
  return listLlmProfiles().find((p) => p.id === id) ?? null;
}

export function saveLlmProfile(profile: LlmModelProfile): void {
  const stored = readStored();
  const existing = stored.llmProfiles ?? [];
  const idx = existing.findIndex((p) => p.id === profile.id);
  const llmProfiles = idx >= 0 ? existing.map((p, i) => (i === idx ? profile : p)) : [...existing, profile];
  const activeLlmProfileId = stored.activeLlmProfileId ?? profile.id;
  writeStored({ ...stored, llmProfiles, activeLlmProfileId });
}

export function deleteLlmProfile(id: string): void {
  const stored = readStored();
  const llmProfiles = (stored.llmProfiles ?? []).filter((p) => p.id !== id);
  const activeLlmProfileId = stored.activeLlmProfileId === id ? (llmProfiles[0]?.id ?? null) : stored.activeLlmProfileId;
  writeStored({ ...stored, llmProfiles, activeLlmProfileId });
}

export function setActiveLlmProfile(id: string): void {
  writeStored({ ...readStored(), activeLlmProfileId: id });
}

/** The doculigent.com account profile — non-secret, so it lives alongside other settings
 *  rather than in the OS keychain (see keyring.ts's refresh-token functions, and
 *  auth/tokenCache.ts for the in-memory-only access token). */
export function getAuthProfile(): { user: AuthUser; expiresAt: string | null } | null {
  const stored = readStored();
  return stored.authUser ? { user: stored.authUser, expiresAt: stored.authExpiresAt ?? null } : null;
}

export function setAuthProfile(user: AuthUser, expiresAt: string | null): void {
  writeStored({ ...readStored(), authUser: user, authExpiresAt: expiresAt });
}

export function clearAuthProfile(): void {
  const { authUser: _authUser, authExpiresAt: _authExpiresAt, ...rest } = readStored();
  writeStored(rest);
}

/** Last-used Record tab settings (camera overlay + capture source), restored on next
 *  open so the user doesn't have to re-pick them every session. */
export function getRecordSettings(): {
  overlay: OverlayConfig | null;
  targetId: string | null;
  mic: MicConfig | null;
} {
  const stored = readStored();
  return {
    overlay: stored.recordOverlay ?? null,
    targetId: stored.recordTargetId ?? null,
    mic: stored.recordMic ?? null,
  };
}

export function setRecordSettings(overlay: OverlayConfig, targetId: string | null, mic: MicConfig | null): void {
  writeStored({ ...readStored(), recordOverlay: overlay, recordTargetId: targetId, recordMic: mic ?? undefined });
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

export function getWhisperModel(): WhisperModelSize {
  return readStored().whisperModel ?? DEFAULT_WHISPER_MODEL;
}

export function setWhisperModel(size: WhisperModelSize): void {
  writeStored({ ...readStored(), whisperModel: size });
}

export function getCursorOverride(): boolean {
  return !!readStored().cursorOverride;
}

export function setCursorOverride(active: boolean): void {
  writeStored({ ...readStored(), cursorOverride: active });
}

export function clearCursorOverride(): void {
  writeStored({ ...readStored(), cursorOverride: false });
}
