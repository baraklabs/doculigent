import { queryClient } from "./queryClient";
import { SettingsService } from "../services/settings/SettingsService";
import { LibraryService } from "../services/library/LibraryService";
import { StorageService } from "../services/storage/StorageService";
import { CACHE_KEYS, putCache } from "./settingsCache";

let warmed = false;

/**
 * Fire-and-forget pre-load of everything the main tabs read on mount, so the first visit to a
 * tab (and every later one) paints from memory instead of waiting on IPC. Failures are
 * ignored — each page still fetches for itself.
 */
export function warmAppCaches() {
  if (warmed) return;
  warmed = true;
  const ignore = () => {};

  SettingsService.getRecordSettings().catch(ignore);
  SettingsService.getMeetingSettings().catch(ignore);
  SettingsService.getRecordingsDir().catch(ignore);
  SettingsService.getWhisperModelsDir().catch(ignore);
  Promise.all([
    SettingsService.getWhisperModel(),
    SettingsService.getWhisperModelStatuses(),
    SettingsService.getUseDoculigentModel(),
    SettingsService.getTranscriptionByokProfileId(),
  ])
    .then((bundle) => putCache(CACHE_KEYS.transcription, bundle))
    .catch(ignore);

  queryClient.prefetchQuery({ queryKey: ["videos", ""], queryFn: () => LibraryService.list() }).catch(ignore);
  queryClient
    .prefetchQuery({ queryKey: ["llmProfiles"], queryFn: () => SettingsService.listLlmProfiles() })
    .catch(ignore);
  queryClient
    .prefetchQuery({ queryKey: ["storagePreference"], queryFn: () => StorageService.getPreference() })
    .catch(ignore);
  queryClient
    .prefetchQuery({ queryKey: ["captureTargets"], queryFn: () => window.api.capture.listTargets() })
    .catch(ignore);
}
