import type { ShareLink, StorageFile, StorageTeam } from "@shared/types/storage";

export interface StorageProvider {
  ensureFolder(): Promise<void>;
  listFiles(): Promise<StorageFile[]>;
  uploadFile(filePath: string, displayName: string, onProgress?: (percent: number) => void): Promise<StorageFile>;
  downloadToTemp(fileId: string): Promise<{ filePath: string; name: string; mimeType: string | null }>;
  deleteFile(fileId: string): Promise<void>;
  getShareableLink(fileId: string): Promise<ShareLink>;
  listTeams?(): Promise<StorageTeam[]>;
  createTeam?(name: string): Promise<StorageTeam>;
  deleteTeam?(teamId: string): Promise<void>;
}
