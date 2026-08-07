import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { ShareLink, StorageFile, StoragePreference, StorageTeam } from "@shared/types/storage";
import type { Video } from "@shared/types/models";
import { getStoragePreference, setStoragePreference } from "../native/settingsStore";
import { setS3SecretKey, deleteS3SecretKey } from "../native/keyring";
import * as libraryStore from "../native/libraryStore";
import * as shareLinkStore from "../native/shareLinkStore";
import { getActiveProvider } from "../storage";
import { syncStorageFileToLibrary } from "../storage/sync";

function broadcastUploadProgress(uploadId: string, percent: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(Channels.storage.uploadProgress, { uploadId, percent });
  }
}

export function registerStorageIpc(): void {
  ipcMain.handle(Channels.storage.getPreference, async (): Promise<StoragePreference> => getStoragePreference());

  ipcMain.handle(
    Channels.storage.setPreference,
    async (_event, preference: StoragePreference, s3SecretKey?: string | null): Promise<void> => {
      if (preference.provider === "s3") {
        if (s3SecretKey) await setS3SecretKey(s3SecretKey);
      } else {
        await deleteS3SecretKey().catch(() => {});
      }

      setStoragePreference(preference);

      if (preference.provider !== "doculigent") {
        const provider = await getActiveProvider();
        await provider.ensureFolder();
      }
    }
  );

  ipcMain.handle(Channels.storage.listTeams, async (): Promise<StorageTeam[]> => {
    const provider = await getActiveProvider();
    return (await provider.listTeams?.()) ?? [];
  });

  ipcMain.handle(Channels.storage.createTeam, async (_event, name: string): Promise<StorageTeam> => {
    const provider = await getActiveProvider();
    if (!provider.createTeam) throw new Error("This storage option doesn't support teams.");
    return provider.createTeam(name);
  });

  ipcMain.handle(Channels.storage.deleteTeam, async (_event, teamId: string): Promise<void> => {
    const teamProvider = await getActiveProvider(teamId);
    const files = await teamProvider.listFiles();

    const provider = await getActiveProvider();
    if (!provider.deleteTeam) throw new Error("This storage option doesn't support deleting teams.");
    await provider.deleteTeam(teamId);

    for (const file of files) {
      const localVideo = libraryStore.getVideoBySyncedTeamFileId(file.id);
      if (localVideo) {
        libraryStore.deleteVideo(localVideo.id);
        await fs.rm(path.dirname(localVideo.filePath), { recursive: true, force: true });
      }
      shareLinkStore.deleteShareLink(file.id);
    }
  });

  ipcMain.handle(Channels.storage.listFiles, async (_event, teamId: string): Promise<StorageFile[]> => {
    const provider = await getActiveProvider(teamId);
    return provider.listFiles();
  });

  ipcMain.handle(
    Channels.storage.uploadFile,
    async (_event, uploadId: string, teamId: string, filePath: string, displayName?: string): Promise<StorageFile> => {
      const provider = await getActiveProvider(teamId);
      return provider.uploadFile(filePath, displayName ?? path.basename(filePath), (percent) =>
        broadcastUploadProgress(uploadId, percent)
      );
    }
  );

  ipcMain.handle(Channels.storage.downloadToLibrary, async (_event, fileId: string): Promise<Video> =>
    syncStorageFileToLibrary(fileId)
  );

  ipcMain.handle(Channels.storage.deleteFile, async (_event, fileId: string): Promise<void> => {
    const provider = await getActiveProvider();
    await provider.deleteFile(fileId);

    const localVideo = libraryStore.getVideoBySyncedTeamFileId(fileId);
    if (localVideo) {
      libraryStore.deleteVideo(localVideo.id);
      await fs.rm(path.dirname(localVideo.filePath), { recursive: true, force: true });
    }
    shareLinkStore.deleteShareLink(fileId);
  });

  ipcMain.handle(Channels.storage.getCachedShareLink, async (_event, fileId: string): Promise<ShareLink | null> =>
    shareLinkStore.getShareLink(fileId)
  );

  ipcMain.handle(Channels.storage.getShareableLink, async (_event, fileId: string): Promise<ShareLink> => {
    const provider = await getActiveProvider();
    const link = await provider.getShareableLink(fileId);
    shareLinkStore.setShareLink(fileId, link);
    return link;
  });
}
