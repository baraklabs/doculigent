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

// Actions block (AiAssistantPage.tsx) — one mutation per action kind, each just a thin
// pass-through to AppsService since there's no shared cache to invalidate (unlike the CRUD
// mutations above, running an action doesn't change the connected-integrations list).
export function useGithubCreateIssue() {
  return useMutation({
    mutationFn: (vars: { integrationId: string; repo: string; title: string; body: string }) =>
      AppsService.githubCreateIssue(vars.integrationId, vars.repo, vars.title, vars.body),
  });
}

export function useGithubCommentIssue() {
  return useMutation({
    mutationFn: (vars: { integrationId: string; repo: string; issueNumber: number; body: string }) =>
      AppsService.githubCommentIssue(vars.integrationId, vars.repo, vars.issueNumber, vars.body),
  });
}

export function useSlackPostMessage() {
  return useMutation({
    mutationFn: (vars: { integrationId: string; channel: string; text: string }) =>
      AppsService.slackPostMessage(vars.integrationId, vars.channel, vars.text),
  });
}
