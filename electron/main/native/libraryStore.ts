
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Summary, Transcript, Video } from "@shared/types/models";
import { libraryStoreFilePath } from "./paths";

interface StoreFile {
  /** App version that last wrote this file — the hook for future migrations. */
  appVersion: string;
  videos: Video[];
}

function emptyStore(): StoreFile {
  return { appVersion: app.getVersion(), videos: [] };
}

function migrate(store: StoreFile): StoreFile {
  return store;
}

function normalizeVideo(raw: Partial<Video>): Video {
  return {
    id: String(raw.id),
    title: raw.title ?? "Untitled",
    filePath: raw.filePath ?? "",
    durationSecs: raw.durationSecs ?? 0,
    overlay: raw.overlay as Video["overlay"],
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    transcript: (raw.transcript as Transcript | null) ?? null,
    summary: (raw.summary as Summary | null) ?? null,
    source: raw.source === "meeting" ? "meeting" : "record",
    syncedFromTeamFileId: raw.syncedFromTeamFileId,
  };
}

let cache: StoreFile | null = null;

function read(): StoreFile {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(libraryStoreFilePath(), "utf-8")) as Partial<StoreFile>;
    cache = migrate({
      appVersion: parsed.appVersion ?? "0.0.0",
      videos: (parsed.videos ?? []).map(normalizeVideo),
    });
  } catch {
    cache = emptyStore();
  }
  return cache;
}

function write(store: StoreFile): void {
  cache = { ...store, appVersion: app.getVersion() };
  const file = libraryStoreFilePath();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

export function insertVideo(video: Video): void {
  const store = read();
  write({ ...store, videos: [...store.videos, video] });
}

function libraryVisible(videos: Video[]): Video[] {
  return videos.filter((v) => !v.syncedFromTeamFileId);
}

export function listVideos(): Video[] {
  return libraryVisible(read().videos).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getVideo(id: string): Video | null {
  return read().videos.find((v) => v.id === id) ?? null;
}

export function getVideoBySyncedTeamFileId(teamFileId: string): Video | null {
  return read().videos.find((v) => v.syncedFromTeamFileId === teamFileId) ?? null;
}

export function listSyncedTeamFileIds(): string[] {
  return read()
    .videos.map((v) => v.syncedFromTeamFileId)
    .filter((id): id is string => !!id);
}

export function deleteVideo(id: string): void {
  const store = read();
  write({ ...store, videos: store.videos.filter((v) => v.id !== id) });
}

export function deleteVideos(ids: string[]): Video[] {
  const store = read();
  const idSet = new Set(ids);
  const removed = store.videos.filter((v) => idSet.has(v.id));
  write({ ...store, videos: store.videos.filter((v) => !idSet.has(v.id)) });
  return removed;
}

function updateVideo(id: string, patch: Partial<Video>): Video | null {
  const store = read();
  const existing = store.videos.find((v) => v.id === id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  write({ ...store, videos: store.videos.map((v) => (v.id === id ? updated : v)) });
  return updated;
}

export function renameVideo(id: string, title: string): Video | null {
  return updateVideo(id, { title });
}


export function updateVideoTranscript(id: string, transcript: Transcript | null): Video | null {
  return updateVideo(id, { transcript });
}

function transcriptText(transcript: Transcript | null): string {
  return transcript ? transcript.segments.map((s) => s.text).join(" ") : "";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

export function searchVideos(query: string): Video[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return listVideos();

  return libraryVisible(read().videos)
    .map((video) => {
      const title = video.title.toLowerCase();
      const transcript = transcriptText(video.transcript).toLowerCase();
      let score = 0;
      for (const token of tokens) {
        const inTitle = title.includes(token);
        const hits = countOccurrences(transcript, token);
        if (!inTitle && hits === 0) return { video, score: -1 };
        if (inTitle) score += 10;
        score += Math.min(hits, 10);
      }
      return { video, score };
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score || b.video.createdAt.localeCompare(a.video.createdAt))
    .map((r) => r.video);
}
