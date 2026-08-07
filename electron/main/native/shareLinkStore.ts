import fs from "node:fs";
import path from "node:path";
import type { ShareLink } from "@shared/types/storage";
import { shareLinksFilePath } from "./paths";

type ShareLinkMap = Record<string, ShareLink>;

function read(): ShareLinkMap {
  try {
    return JSON.parse(fs.readFileSync(shareLinksFilePath(), "utf-8")) as ShareLinkMap;
  } catch {
    return {};
  }
}

function write(map: ShareLinkMap): void {
  const file = shareLinksFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
}

/** Returns the cached link only if it hasn't expired yet — an expired entry is treated the
 *  same as "no link generated" so callers know to regenerate. */
export function getShareLink(fileId: string): ShareLink | null {
  const link = read()[fileId];
  if (!link) return null;
  return new Date(link.expiresAt).getTime() > Date.now() ? link : null;
}

export function setShareLink(fileId: string, link: ShareLink): void {
  write({ ...read(), [fileId]: link });
}

export function deleteShareLink(fileId: string): void {
  const map = read();
  delete map[fileId];
  write(map);
}
