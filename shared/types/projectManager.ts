
export type PmPersonaId = string;

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
  storageProvider?: "doculigent" | "s3" | "google_drive";
  persona: PmPersonaId;
  insights: PmFileInsight[];
  overallInsight?: PmOverallInsight | null;
  chatProfileId?: string | null;
  transcribeModel?: string | null;
  createdAt: string;
  autoProcessedAt?: string | null;
}
