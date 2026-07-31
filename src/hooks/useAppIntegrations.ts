import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppIntegration, AppIntegrationKind } from "@shared/types/models";
import { AppsService } from "../services/apps/AppsService";

export function useAppIntegrations() {
  return useQuery<AppIntegration[]>({
    queryKey: ["appIntegrations"],
    queryFn: () => AppsService.list(),
  });
}

function useInvalidateIntegrations() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["appIntegrations"] });
}

export function useSaveAppIntegration() {
  const invalidate = useInvalidateIntegrations();
  return useMutation({
    mutationFn: ({ integration, secret }: { integration: AppIntegration; secret?: string | null }) =>
      AppsService.save(integration, secret),
    onSuccess: invalidate,
  });
}

export function useDeleteAppIntegration() {
  const invalidate = useInvalidateIntegrations();
  return useMutation({
    mutationFn: (id: string) => AppsService.delete(id),
    onSuccess: invalidate,
  });
}

export function useTestAppConnection() {
  return useMutation({
    mutationFn: ({
      kind,
      integrationId,
      secret,
    }: {
      kind: AppIntegrationKind;
      integrationId: string | null;
      secret?: string | null;
    }) => AppsService.testConnection(kind, integrationId, secret),
  });
}
