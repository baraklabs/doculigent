import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LlmModelProfile } from "@shared/types/models";
import { SettingsService } from "../services/settings/SettingsService";
import { AiService } from "../services/ai/AiService";

export function useLlmProfiles() {
  return useQuery<LlmModelProfile[]>({
    queryKey: ["llmProfiles"],
    queryFn: () => SettingsService.listLlmProfiles(),
  });
}

export function useActiveLlmProfileId() {
  return useQuery<string | null>({
    queryKey: ["activeLlmProfileId"],
    queryFn: () => SettingsService.getActiveLlmProfileId(),
  });
}

function useInvalidateProfiles() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["llmProfiles"] });
    queryClient.invalidateQueries({ queryKey: ["activeLlmProfileId"] });
  };
}

export function useSaveLlmProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: ({ profile, apiKey }: { profile: LlmModelProfile; apiKey?: string | null }) =>
      SettingsService.saveLlmProfile(profile, apiKey),
    onSuccess: invalidate,
  });
}

export function useDeleteLlmProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: (id: string) => SettingsService.deleteLlmProfile(id),
    onSuccess: invalidate,
  });
}

export function useSetActiveLlmProfile() {
  const invalidate = useInvalidateProfiles();
  return useMutation({
    mutationFn: (id: string) => SettingsService.setActiveLlmProfile(id),
    onSuccess: invalidate,
  });
}

export function useTestLlmConnection() {
  return useMutation({
    mutationFn: ({ profile, apiKey }: { profile: LlmModelProfile; apiKey?: string | null }) =>
      AiService.testConnection(profile, apiKey),
  });
}
