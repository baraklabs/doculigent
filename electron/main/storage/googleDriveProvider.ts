import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import type { GoogleDriveConfig, ShareLink, StorageFile } from "@shared/types/storage";
import { getValidGoogleDriveAccessToken, refreshGoogleDriveAccessToken } from "../auth/googleDriveAuth";
import { guessMimeType } from "../teams/upload";
import type { StorageProvider } from "./StorageProvider";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const CHUNK_SIZE = 8 * 1024 * 1024;

const SHARE_LINK_LABEL_SECONDS = 7 * 24 * 60 * 60;

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let token = await getValidGoogleDriveAccessToken();
  const withAuth = (bearer: string): RequestInit => ({
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${bearer}` },
  });

  let res = await fetch(url, withAuth(token));
  if (res.status === 401) {
    token = await refreshGoogleDriveAccessToken();
    res = await fetch(url, withAuth(token));
  }
  return res;
}

async function driveErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message || text || res.statusText;
  } catch {
    return text || res.statusText;
  }
}

async function driveJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await driveFetch(url, init);
  if (!res.ok) throw new Error(`Google Drive request failed (${res.status}): ${await driveErrorDetail(res)}`);
  return (await res.json()) as T;
}

async function findChildFolder(name: string, parentId: string): Promise<string | null> {
  const q = encodeURIComponent(
    `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`
  );
  const res = await driveJson<{ files: { id: string }[] }>(`${DRIVE_API}/files?q=${q}&fields=files(id)&spaces=drive`);
  return res.files[0]?.id ?? null;
}

async function createChildFolder(name: string, parentId: string): Promise<string> {
  const res = await driveJson<{ id: string }>(`${DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return res.id;
}

async function findOrCreateFolder(name: string, parentId: string): Promise<string> {
  return (await findChildFolder(name, parentId)) ?? createChildFolder(name, parentId);
}

export async function createGoogleDriveProvider(config: GoogleDriveConfig): Promise<StorageProvider> {
  const rootName = config.folder.trim() || "Doculigent";

  let rootFolderIdPromise: Promise<string> | null = null;
  let sharedFolderIdPromise: Promise<string> | null = null;

  function rootFolderId(): Promise<string> {
    if (!rootFolderIdPromise) rootFolderIdPromise = findOrCreateFolder(rootName, "root");
    return rootFolderIdPromise;
  }
  function sharedFolderId(): Promise<string> {
    if (!sharedFolderIdPromise) sharedFolderIdPromise = rootFolderId().then((id) => findOrCreateFolder("shared", id));
    return sharedFolderIdPromise;
  }

  return {
    async ensureFolder(): Promise<void> {
      await sharedFolderId();
    },

    async listFiles(): Promise<StorageFile[]> {
      const parentId = await sharedFolderId();
      const q = encodeURIComponent(`'${parentId}' in parents and mimeType!='${FOLDER_MIME}' and trashed=false`);
      const res = await driveJson<{
        files: { id: string; name: string; size?: string; mimeType?: string; createdTime?: string }[];
      }>(`${DRIVE_API}/files?q=${q}&fields=files(id,name,size,mimeType,createdTime)&spaces=drive&pageSize=1000`);
      return res.files.map((f) => ({
        id: f.id,
        name: f.name,
        sizeBytes: f.size ? Number(f.size) : 0,
        mimeType: f.mimeType ?? guessMimeType(f.name),
        createdAt: f.createdTime ?? new Date().toISOString(),
      }));
    },

    async uploadFile(
      filePath: string,
      displayName: string,
      onProgress?: (percent: number) => void
    ): Promise<StorageFile> {
      const parentId = await sharedFolderId();
      const mimeType = guessMimeType(displayName);
      const { size } = await fs.promises.stat(filePath);

      const startRes = await driveFetch(`${DRIVE_UPLOAD_API}?uploadType=resumable&fields=id`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name: displayName, parents: [parentId] }),
      });
      if (!startRes.ok) throw new Error(`Couldn't start Google Drive upload (${startRes.status}).`);
      const sessionUrl = startRes.headers.get("Location");
      if (!sessionUrl) throw new Error("Google Drive didn't return an upload session URL.");

      async function putChunk(buffer: Buffer, start: number, end: number): Promise<{ id: string } | null> {
        const res = await driveFetch(sessionUrl!, {
          method: "PUT",
          headers: {
            "Content-Length": String(buffer.length),
            "Content-Range": size === 0 ? "bytes */0" : `bytes ${start}-${end}/${size}`,
          },
          body: buffer,
        });
        if (res.status === 200 || res.status === 201) return (await res.json()) as { id: string };
        if (res.status === 308) return null;
        const text = await res.text().catch(() => "");
        throw new Error(`Google Drive upload failed (${res.status}): ${text || res.statusText}`);
      }

      if (size === 0) {
        const done = await putChunk(Buffer.alloc(0), 0, -1);
        onProgress?.(100);
        return { id: done!.id, name: displayName, sizeBytes: 0, mimeType, createdAt: new Date().toISOString() };
      }

      const handle = await fs.promises.open(filePath, "r");
      try {
        let uploaded = 0;
        let fileId = "";
        while (uploaded < size) {
          const chunkSize = Math.min(CHUNK_SIZE, size - uploaded);
          const buffer = Buffer.alloc(chunkSize);
          await handle.read(buffer, 0, chunkSize, uploaded);
          const done = await putChunk(buffer, uploaded, uploaded + chunkSize - 1);
          uploaded += chunkSize;
          if (done) {
            fileId = done.id;
            onProgress?.(100);
            break;
          }
          onProgress?.(Math.min(99, Math.round((uploaded / size) * 100)));
        }
        return { id: fileId, name: displayName, sizeBytes: size, mimeType, createdAt: new Date().toISOString() };
      } finally {
        await handle.close();
      }
    },

    async downloadToTemp(fileId: string): Promise<{ filePath: string; name: string; mimeType: string | null }> {
      const meta = await driveJson<{ name: string; mimeType?: string }>(
        `${DRIVE_API}/files/${fileId}?fields=name,mimeType`
      );
      const res = await driveFetch(`${DRIVE_API}/files/${fileId}?alt=media`);
      if (!res.ok || !res.body) throw new Error(`Couldn't download "${meta.name}" from Google Drive (${res.status}).`);

      const tempPath = path.join(os.tmpdir(), `doculigent-gdrive-dl-${crypto.randomUUID()}${path.extname(meta.name)}`);
      await pipeline(res.body as unknown as NodeJS.ReadableStream, fs.createWriteStream(tempPath));

      return { filePath: tempPath, name: meta.name, mimeType: meta.mimeType ?? guessMimeType(meta.name) };
    },

    async deleteFile(fileId: string): Promise<void> {
      const res = await driveFetch(`${DRIVE_API}/files/${fileId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Couldn't delete file from Google Drive (${res.status}): ${await driveErrorDetail(res)}`);
      }
    },

    async getShareableLink(fileId: string): Promise<ShareLink> {
      const res = await driveFetch(`${DRIVE_API}/files/${fileId}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "reader", type: "anyone" }),
      });
      if (!res.ok) throw new Error(`Couldn't share the Google Drive file (${res.status}).`);

      const meta = await driveJson<{ webViewLink?: string }>(`${DRIVE_API}/files/${fileId}?fields=webViewLink`);
      const url = meta.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
      return { url, expiresAt: new Date(Date.now() + SHARE_LINK_LABEL_SECONDS * 1000).toISOString() };
    },
  };
}
