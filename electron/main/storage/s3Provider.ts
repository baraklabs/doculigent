import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  NotFound,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type { S3Config, ShareLink, StorageFile, StorageTeam } from "@shared/types/storage";
import { getS3SecretKey } from "../native/keyring";
import { guessMimeType } from "../teams/upload";
import type { StorageProvider } from "./StorageProvider";

// AWS's hard cap for a SigV4 URL presigned with static/IAM credentials — getSignedUrl
// throws past a week, so this is the maximum a share link can stay valid for.
const SHARE_LINK_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

function normalizeFolder(folder: string): string {
  const trimmed = (folder.trim() || "Doculigent").replace(/^\/+/, "");
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function sanitizeSegment(name: string): string {
  return name.trim().replace(/[/\\]+/g, "-").replace(/^\.+/, "");
}

export async function createS3Provider(config: S3Config, teamId?: string): Promise<StorageProvider> {
  const secretAccessKey = await getS3SecretKey();
  if (!secretAccessKey) {
    throw new Error("No S3 secret access key saved — reconnect your S3 bucket in Settings.");
  }

  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint || undefined,
    forcePathStyle: !!config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey },
  });
  const rootFolder = normalizeFolder(config.folder);
  const teamsRoot = `${rootFolder}teams/`;
  const sharedRoot = `${rootFolder}shared/`;
  const folder = teamId ? `${teamsRoot}${sanitizeSegment(teamId)}/` : sharedRoot;
  const folderMarkerKey = folder;

  return {
    async ensureFolder(): Promise<void> {
      for (const key of [rootFolder, teamsRoot, sharedRoot]) {
        if (!key) continue;
        try {
          await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        } catch (err) {
          if (err instanceof NotFound || (err as { name?: string }).name === "NotFound") {
            await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: "" }));
          } else {
            throw err;
          }
        }
      }
    },

    async listTeams(): Promise<StorageTeam[]> {
      const res = await client.send(
        new ListObjectsV2Command({ Bucket: config.bucket, Prefix: teamsRoot, Delimiter: "/" })
      );
      return (res.CommonPrefixes ?? [])
        .map((p) => (p.Prefix ?? "").slice(teamsRoot.length).replace(/\/$/, ""))
        .filter(Boolean)
        .map((id) => ({ id, name: id }));
    },

    async createTeam(name: string): Promise<StorageTeam> {
      const id = sanitizeSegment(name);
      if (!id) throw new Error("Enter a team name.");
      await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${teamsRoot}${id}/`, Body: "" }));
      return { id, name: id };
    },

    async deleteTeam(id: string): Promise<void> {
      const prefix = `${teamsRoot}${sanitizeSegment(id)}/`;
      let continuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: continuationToken })
        );
        const keys = (page.Contents ?? []).map((obj) => obj.Key).filter((key): key is string => !!key);
        if (keys.length > 0) {
          await client.send(
            new DeleteObjectsCommand({
              Bucket: config.bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })) },
            })
          );
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (continuationToken);
    },

    async listFiles(): Promise<StorageFile[]> {
      const res = await client.send(
        new ListObjectsV2Command({ Bucket: config.bucket, Prefix: folder })
      );
      return (res.Contents ?? [])
        .filter((obj) => obj.Key && obj.Key !== folderMarkerKey && !obj.Key.endsWith("/"))
        .map((obj) => ({
          id: obj.Key as string,
          name: path.basename(obj.Key as string),
          sizeBytes: obj.Size ?? 0,
          mimeType: guessMimeType(obj.Key as string),
          createdAt: (obj.LastModified ?? new Date()).toISOString(),
        }));
    },

    async uploadFile(
      filePath: string,
      displayName: string,
      onProgress?: (percent: number) => void
    ): Promise<StorageFile> {
      const mimeType = guessMimeType(displayName);
      const { size } = await fs.promises.stat(filePath);
      const key = `${folder}${displayName}`;

      const upload = new Upload({
        client,
        params: {
          Bucket: config.bucket,
          Key: key,
          Body: fs.createReadStream(filePath),
          ContentType: mimeType,
        },
      });
      if (onProgress) {
        upload.on("httpUploadProgress", (progress) => {
          if (progress.loaded && size) onProgress(Math.min(99, Math.round((progress.loaded / size) * 100)));
        });
      }
      await upload.done();
      onProgress?.(100);

      return { id: key, name: displayName, sizeBytes: size, mimeType, createdAt: new Date().toISOString() };
    },

    async downloadToTemp(fileId: string): Promise<{ filePath: string; name: string; mimeType: string | null }> {
      const res = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: fileId }));
      if (!res.Body) throw new Error(`Couldn't download "${fileId}" from S3 — empty response body.`);

      const name = path.basename(fileId);
      const tempPath = path.join(os.tmpdir(), `doculigent-s3-dl-${crypto.randomUUID()}${path.extname(name)}`);
      await pipeline(res.Body as NodeJS.ReadableStream, fs.createWriteStream(tempPath));

      return { filePath: tempPath, name, mimeType: res.ContentType ?? guessMimeType(name) };
    },

    async deleteFile(fileId: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: fileId }));
    },

    async getShareableLink(fileId: string): Promise<ShareLink> {
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: config.bucket, Key: fileId }), {
        expiresIn: SHARE_LINK_EXPIRY_SECONDS,
      });
      return { url, expiresAt: new Date(Date.now() + SHARE_LINK_EXPIRY_SECONDS * 1000).toISOString() };
    },
  };
}
