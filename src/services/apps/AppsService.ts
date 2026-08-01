import type { AppIntegration, AppIntegrationKind } from "@shared/types/models";

export const AppsService = {
  list(): Promise<AppIntegration[]> {
    return window.api.apps.list();
  },
  save(integration: AppIntegration, secret?: string | null): Promise<void> {
    return window.api.apps.save(integration, secret);
  },
  delete(id: string): Promise<void> {
    return window.api.apps.delete(id);
  },
  testConnection(
    kind: AppIntegrationKind,
    integrationId: string | null,
    secret?: string | null
  ): Promise<{ ok: boolean; message: string }> {
    return window.api.apps.testConnection(kind, integrationId, secret);
  },
  githubCreateIssue(
    integrationId: string,
    repo: string,
    title: string,
    body: string
  ): Promise<{ ok: boolean; message: string; url?: string }> {
    return window.api.apps.githubCreateIssue(integrationId, repo, title, body);
  },
  githubCommentIssue(
    integrationId: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<{ ok: boolean; message: string; url?: string }> {
    return window.api.apps.githubCommentIssue(integrationId, repo, issueNumber, body);
  },
  slackPostMessage(integrationId: string, channel: string, text: string): Promise<{ ok: boolean; message: string }> {
    return window.api.apps.slackPostMessage(integrationId, channel, text);
  },
};
