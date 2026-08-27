import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { Channels } from "@shared/constants/channels";
import type { ShareLink, StorageFile, StoragePreference, StorageTeam } from "@shared/types/storage";
import type { Video } from "@shared/types/models";
import { getStoragePreference, setStoragePreference } from "../native/settingsStore";
import { setS3SecretKey, getS3SecretKey } from "../native/keyring";
import * as libraryStore from "../native/libraryStore";
import * as shareLinkStore from "../native/shareLinkStore";
import { getActiveProvider } from "../storage";
import { syncStorageFileToLibrary } from "../storage/sync";
import * as doculigentAuth from "../auth/doculigentAuth";
import { getGoogleDriveStatus, getValidGoogleDriveAccessToken } from "../auth/googleDriveAuth";

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
      if (s3SecretKey) await setS3SecretKey(s3SecretKey);

      setStoragePreference(preference);

      if (preference.provider !== "doculigent") {
        const provider = await getActiveProvider();
        await provider.ensureFolder();
      }
    }
  );

  ipcMain.handle(
    Channels.storage.testConnection,
    async (
      _event,
      preference: StoragePreference,
      s3SecretKeyOverride?: string | null
    ): Promise<{ ok: boolean; message: string }> => {
      try {
        if (preference.provider === "doculigent") {
          const session = await doculigentAuth.getSession();
          if (!session) throw new Error("Not signed in — sign in with your doculigent.com account first.");
          return { ok: true, message: `Signed in as ${session.user.email || session.user.name}.` };
        }

        if (preference.provider === "s3") {
          const s3 = preference.s3;
          if (!s3?.accessKeyId || !s3.region || !s3.bucket) throw new Error("Fill in access key, region, and bucket first.");
          const secretAccessKey = s3SecretKeyOverride || (await getS3SecretKey());
          if (!secretAccessKey) throw new Error("Enter the secret access key to test.");

          const client = new S3Client({
            region: s3.region,
            endpoint: s3.endpoint || undefined,
            forcePathStyle: !!s3.endpoint,
            credentials: { accessKeyId: s3.accessKeyId, secretAccessKey },
          });
          await client.send(new HeadBucketCommand({ Bucket: s3.bucket }));
          return { ok: true, message: `Connected to bucket "${s3.bucket}".` };
        }

        if (preference.provider === "google_drive") {
          const status = await getGoogleDriveStatus();
          if (!status.connected) throw new Error("Not connected — sign in with Google first.");
          await getValidGoogleDriveAccessToken();
          return { ok: true, message: `Connected as ${status.email}.` };
        }

        throw new Error("Unknown storage provider.");
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
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
