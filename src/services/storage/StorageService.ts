import type { ShareLink, StorageFile, StoragePreference, StorageTeam } from "@shared/types/storage";
import type { Video } from "@shared/types/models";

export const StorageService = {
  getPreference(): Promise<StoragePreference> {
    return window.api.storage.getPreference();
  },
  setPreference(preference: StoragePreference, s3SecretKey?: string | null): Promise<void> {
    return window.api.storage.setPreference(preference, s3SecretKey);
  },
  listTeams(): Promise<StorageTeam[]> {
    return window.api.storage.listTeams();
  },
  createTeam(name: string): Promise<StorageTeam> {
    return window.api.storage.createTeam(name);
  },
  deleteTeam(teamId: string): Promise<void> {
    return window.api.storage.deleteTeam(teamId);
  },
  listFiles(teamId: string): Promise<StorageFile[]> {
    return window.api.storage.listFiles(teamId);
  },
  uploadFile(uploadId: string, teamId: string, filePath: string, displayName?: string): Promise<StorageFile> {
    return window.api.storage.uploadFile(uploadId, teamId, filePath, displayName);
  },
  onUploadProgress(callback: (progress: { uploadId: string; percent: number }) => void): () => void {
    return window.api.storage.onUploadProgress(callback);
  },
  downloadToLibrary(fileId: string): Promise<Video> {
    return window.api.storage.downloadToLibrary(fileId);
  },
  deleteFile(fileId: string): Promise<void> {
    return window.api.storage.deleteFile(fileId);
  },
  getShareableLink(fileId: string): Promise<ShareLink> {
    return window.api.storage.getShareableLink(fileId);
  },
  getCachedShareLink(fileId: string): Promise<ShareLink | null> {
    return window.api.storage.getCachedShareLink(fileId);
  },
  testConnection(preference: StoragePreference, s3SecretKey?: string | null): Promise<{ ok: boolean; message: string }> {
    return window.api.storage.testConnection(preference, s3SecretKey);
  },
};
