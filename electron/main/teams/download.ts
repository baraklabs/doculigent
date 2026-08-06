
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import * as teamApi from "./api";

function extensionFor(name: string, mimeType: string | null): string {
  const fromName = path.extname(name);
  if (fromName) return fromName;
  const subtype = mimeType?.split("/")[1];
  return subtype ? `.${subtype}` : "";
}

export async function downloadTeamFileToTemp(
  fileId: string
): Promise<{ filePath: string; kind: "video" | "audio"; name: string }> {
  const ticket = await teamApi.presignDownload(fileId);
  const kind: "video" | "audio" = (ticket.mimeType ?? "").startsWith("audio/") ? "audio" : "video";

  let res: Response;
  try {
    res = await fetch(ticket.url);
  } catch {
    throw new Error(`Couldn't reach the download server for "${ticket.name}" — check your connection and try again.`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`Couldn't download "${ticket.name}" (${res.status})`);
  }

  const tempPath = path.join(
    os.tmpdir(),
    `doculigent-team-dl-${crypto.randomUUID()}${extensionFor(ticket.name, ticket.mimeType)}`
  );
  await pipeline(Readable.fromWeb(res.body as NodeWebReadableStream<Uint8Array>), fs.createWriteStream(tempPath));

  return { filePath: tempPath, kind, name: ticket.name };
}
