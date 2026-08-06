
export interface Team {
  id: string;
  name: string;
  ownerId: string;
  isOwner: boolean;
  quotaBytes: number;
  usedBytes: number;
  memberCount: number;
  fileCount: number;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  email: string;
  userId: string | null;
  isOwner: boolean;
  status: "active" | "pending";
  createdAt: string;
}

export type TeamFileStatus = "active" | "trash" | "archived";

export interface TeamFile {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string | null;
  status: TeamFileStatus;
  uploadedBy: string;
  createdAt: string;
}

export interface FileUploadTicket {
  fileId: string;
  storagePath: string;
  uploadUrl: string;
  fields: Record<string, string>;
  expiresAt: string;
}

export interface FileDownloadTicket {
  url: string;
  expiresAt: string;
  name: string;
  mimeType: string | null;
}
