/**
 * SQLite access layer (better-sqlite3), backing the video Library + local search.
 * Schema is mirrored in db/schema.sql (see that file's header for why it's duplicated
 * here as an inline string rather than read from disk at runtime).
 */
import Database from "better-sqlite3";
import type { OverlayConfig, Summary, Transcript, Video } from "@shared/types/models";
import { databaseFilePath } from "./paths";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  duration_secs REAL NOT NULL,
  overlay_config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  transcript_json TEXT,
  summary_json TEXT,
  source TEXT NOT NULL DEFAULT 'record'
);

CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
  id UNINDEXED,
  title,
  transcript_text
);
`;

let db: Database.Database | null = null;

// Cached for the process lifetime. The database itself lives in the fixed userData
// dir (see paths.ts) — relocating the video save dir (settings:setSaveDir) never moves
// it.
function getDb(): Database.Database {
  if (!db) {
    db = new Database(databaseFilePath());
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA_SQL);
    // Migration for DBs created before the Meeting tab existed — CREATE TABLE IF NOT
    // EXISTS above doesn't add columns to an already-existing table.
    const columns = db.prepare(`PRAGMA table_info(videos)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "source")) {
      db.exec(`ALTER TABLE videos ADD COLUMN source TEXT NOT NULL DEFAULT 'record'`);
    }
  }
  return db;
}

interface VideoRow {
  id: string;
  title: string;
  file_path: string;
  duration_secs: number;
  overlay_config: string;
  created_at: string;
  transcript_json: string | null;
  summary_json: string | null;
  source: string;
}

function rowToVideo(row: VideoRow): Video {
  return {
    id: row.id,
    title: row.title,
    filePath: row.file_path,
    durationSecs: row.duration_secs,
    overlay: JSON.parse(row.overlay_config) as OverlayConfig,
    createdAt: row.created_at,
    transcript: row.transcript_json ? (JSON.parse(row.transcript_json) as Transcript) : null,
    summary: row.summary_json ? (JSON.parse(row.summary_json) as Summary) : null,
    source: row.source === "meeting" ? "meeting" : "record",
  };
}

/** Flattens a transcript's segment text into one searchable string. */
function transcriptText(transcript: Transcript | null): string {
  return transcript ? transcript.segments.map((s) => s.text).join(" ") : "";
}

export function insertVideo(video: Video): void {
  const conn = getDb();
  const insert = conn.transaction((v: Video) => {
    conn
      .prepare(
        `INSERT INTO videos (id, title, file_path, duration_secs, overlay_config, created_at, transcript_json, summary_json, source)
         VALUES (@id, @title, @filePath, @durationSecs, @overlayConfig, @createdAt, @transcriptJson, @summaryJson, @source)`
      )
      .run({
        id: v.id,
        title: v.title,
        filePath: v.filePath,
        durationSecs: v.durationSecs,
        overlayConfig: JSON.stringify(v.overlay),
        createdAt: v.createdAt,
        transcriptJson: v.transcript ? JSON.stringify(v.transcript) : null,
        summaryJson: v.summary ? JSON.stringify(v.summary) : null,
        source: v.source,
      });
    conn
      .prepare(`INSERT INTO videos_fts (id, title, transcript_text) VALUES (?, ?, ?)`)
      .run(v.id, v.title, transcriptText(v.transcript));
  });
  insert(video);
}

export function listVideos(): Video[] {
  const rows = getDb().prepare(`SELECT * FROM videos ORDER BY created_at DESC`).all() as VideoRow[];
  return rows.map(rowToVideo);
}

export function getVideo(id: string): Video | null {
  const row = getDb().prepare(`SELECT * FROM videos WHERE id = ?`).get(id) as VideoRow | undefined;
  return row ? rowToVideo(row) : null;
}

export function deleteVideo(id: string): void {
  const conn = getDb();
  const del = conn.transaction((videoId: string) => {
    conn.prepare(`DELETE FROM videos WHERE id = ?`).run(videoId);
    conn.prepare(`DELETE FROM videos_fts WHERE id = ?`).run(videoId);
  });
  del(id);
}

/** Trim is a metadata-only stub today (see FUNCTIONALITY.md §9) — updates duration only. */
export function updateVideoDuration(id: string, durationSecs: number): Video | null {
  getDb().prepare(`UPDATE videos SET duration_secs = ? WHERE id = ?`).run(durationSecs, id);
  return getVideo(id);
}

export function renameVideo(id: string, title: string): Video | null {
  const conn = getDb();
  const rename = conn.transaction((videoId: string, newTitle: string) => {
    conn.prepare(`UPDATE videos SET title = ? WHERE id = ?`).run(newTitle, videoId);
    conn.prepare(`UPDATE videos_fts SET title = ? WHERE id = ?`).run(newTitle, videoId);
  });
  rename(id, title);
  return getVideo(id);
}

/** Used by the Library page's Transcribe action — persists the result so "Transcribed"
 *  filtering and full-text search both pick it up immediately. */
export function updateVideoTranscript(id: string, transcript: Transcript | null): Video | null {
  const conn = getDb();
  const update = conn.transaction((videoId: string, t: Transcript | null) => {
    conn.prepare(`UPDATE videos SET transcript_json = ? WHERE id = ?`).run(t ? JSON.stringify(t) : null, videoId);
    conn.prepare(`UPDATE videos_fts SET transcript_text = ? WHERE id = ?`).run(transcriptText(t), videoId);
  });
  update(id, transcript);
  return getVideo(id);
}

/** Escapes + prefix-matches each whitespace-separated token so arbitrary user input
 *  (quotes, hyphens, colons — all meaningful to FTS5's query syntax otherwise) is safe. */
function buildFtsQuery(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(" ");
}

export function searchVideos(query: string): Video[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return listVideos();
  const rows = getDb()
    .prepare(
      `SELECT v.* FROM videos v
       JOIN videos_fts f ON f.id = v.id
       WHERE f MATCH ?
       ORDER BY f.rank`
    )
    .all(ftsQuery) as VideoRow[];
  return rows.map(rowToVideo);
}
