import type { ShareLink, StorageFile } from "@shared/types/storage";
import type { StorageProvider } from "./StorageProvider";
import * as teamApi from "../teams/api";
import { uploadTeamFile } from "../teams/upload";
import { downloadTeamFileToTemp } from "../teams/download";

export function createDoculigentProvider(teamId: string): StorageProvider {
  return {
    async ensureFolder(): Promise<void> {
      // Supabase Storage manages the destination — nothing to create client-side.
    },

    async listFiles(): Promise<StorageFile[]> {
      const files = await teamApi.listFiles(teamId);
      return files.map((f) => ({
        id: f.id,
        name: f.name,
        sizeBytes: f.sizeBytes,
        mimeType: f.mimeType,
        createdAt: f.createdAt,
      }));
    },

    async uploadFile(
      filePath: string,
      displayName: string,
      onProgress?: (percent: number) => void
    ): Promise<StorageFile> {
      const file = await uploadTeamFile(teamId, filePath, displayName, onProgress);
      return { id: file.id, name: file.name, sizeBytes: file.sizeBytes, mimeType: file.mimeType, createdAt: file.createdAt };
    },

    async downloadToTemp(fileId: string): Promise<{ filePath: string; name: string; mimeType: string | null }> {
      const { filePath, name } = await downloadTeamFileToTemp(fileId);
      return { filePath, name, mimeType: null };
    },

    async deleteFile(fileId: string): Promise<void> {
      await teamApi.permanentlyDeleteFile(fileId);
    },

    async getShareableLink(fileId: string): Promise<ShareLink> {
      const ticket = await teamApi.presignDownload(fileId);
      return { url: ticket.url, expiresAt: ticket.expiresAt };
    },
  };
}
