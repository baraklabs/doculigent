
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import * as teamApi from "./api";
import type { TeamFile } from "@shared/types/team";

const CRLF = "\r\n";

const EXTENSION_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};
export function guessMimeType(fileName: string): string {
  return EXTENSION_MIME[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

async function uploadToPresignedUrl(
  uploadUrl: string,
  fields: Record<string, string>,
  filePath: string,
  fileName: string,
  mimeType: string,
  totalBytes: number,
  onProgress?: (percent: number) => void
): Promise<void> {
  const boundary = `----doculigent${crypto.randomBytes(16).toString("hex")}`;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`--${boundary}${CRLF}Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}${value}${CRLF}`);
  }
  parts.push(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}Content-Type: ${mimeType}${CRLF}${CRLF}`
  );
  const preamble = Buffer.from(parts.join(""), "utf-8");
  const epilogue = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf-8");
  const contentLength = preamble.byteLength + totalBytes + epilogue.byteLength;

  const fileStream = fs.createReadStream(filePath);
  let sent = 0;
  const body = Readable.toWeb(
    Readable.from(
      (async function* () {
        yield preamble;
        for await (const chunk of fileStream) {
          sent += (chunk as Buffer).length;
          onProgress?.(Math.min(99, Math.round((sent / totalBytes) * 100)));
          yield chunk as Buffer;
        }
        yield epilogue;
      })()
    )
  ) as NodeWebReadableStream<Uint8Array>;

  let res: Response;
  try {
    res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": String(contentLength),
      },
      body,
      duplex: "half",
    } as RequestInit);
  } catch {
    throw new Error("Couldn't reach the upload server — check your connection and try again.");
  }
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  }
}

export async function uploadTeamFile(
  teamId: string,
  filePath: string,
  displayName?: string,
  onProgress?: (percent: number) => void
): Promise<TeamFile> {
  const fileName = displayName ?? path.basename(filePath);
  const mimeType = guessMimeType(fileName);
  const { size } = await fs.promises.stat(filePath);

  const ticket = await teamApi.presignUpload(teamId, fileName, mimeType, size);
  await uploadToPresignedUrl(ticket.uploadUrl, ticket.fields, filePath, fileName, mimeType, size, onProgress);
  onProgress?.(100);
  return teamApi.confirmUpload(teamId, ticket.fileId, ticket.storagePath, fileName, mimeType);
}
