
export type PmPersonaId = string;

export type PmTriggerMode = "manual" | "scheduled";

export interface PmGithubIssueAction {
  enabled: boolean;
  integrationId: string;
  repo: string; 
}

export interface PmSlackAction {
  enabled: boolean;
  integrationId: string;
  channel: string;
}

export interface PmActionsConfig {
  githubCreateIssue?: PmGithubIssueAction;
  slackPostMessage?: PmSlackAction;
}

export interface PmFileInsight {
  fileId: string;
  fileName: string;
  quick: string;
  detailed: string;
  generatedAt: string; 
}

export interface PmOverallInsight {
  quick: string;
  detailed: string;
  generatedAt: string;
}

export interface ProjectManager {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  storageProvider?: "doculigent" | "s3";
  persona: PmPersonaId;
  triggerMode: PmTriggerMode;
  scheduleTime?: string | null;
  actions: PmActionsConfig;
  insights: PmFileInsight[];
  overallInsight?: PmOverallInsight | null;
  chatProfileId?: string | null;
  transcribeModel?: string | null;
  createdAt: string; 
  lastRunAt?: string | null;
  autoProcessedAt?: string | null;
}

export interface PmActionOutcome {
  kind: "githubCreateIssue" | "slackPostMessage";
  ok: boolean;
  message: string;
  url?: string;
}

export interface PmRunResult {
  ok: boolean;
  message: string;
  actionResults: PmActionOutcome[];
}
