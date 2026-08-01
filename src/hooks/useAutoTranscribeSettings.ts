import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AutoTranscribeSettings } from "@shared/types/models";
import { SettingsService } from "../services/settings/SettingsService";

export const AUTO_TRANSCRIBE_SETTINGS_KEY = ["autoTranscribeSettings"];

export function useAutoTranscribeSettings() {
  return useQuery<AutoTranscribeSettings>({
    queryKey: AUTO_TRANSCRIBE_SETTINGS_KEY,
    queryFn: () => SettingsService.getAutoTranscribeSettings(),
  });
}

export function useSetAutoTranscribeSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: AutoTranscribeSettings) => SettingsService.setAutoTranscribeSettings(settings),
    onSuccess: (_void, settings) => queryClient.setQueryData(AUTO_TRANSCRIBE_SETTINGS_KEY, settings),
  });
}
