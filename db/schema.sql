-- Reference copy of the schema — the executable source of truth is the inline string in
-- electron/main/native/db.ts (kept there directly to avoid any runtime file-path
-- resolution risk across dev/packaged/asar contexts for what is a tiny, static schema).
-- Keep the two in sync if you change either.

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  duration_secs REAL NOT NULL,
  overlay_config TEXT NOT NULL, -- JSON: OverlayConfig
  created_at TEXT NOT NULL,     -- ISO 8601
  transcript_json TEXT,         -- JSON: Transcript | null
  summary_json TEXT             -- JSON: Summary | null
);

-- Local search (SearchService): plain (non-external-content) FTS5 index, kept in sync by
-- explicit calls from db.ts rather than SQL triggers, so the "flatten transcript segments
-- into searchable text" logic lives in one place in TypeScript.
CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
  id UNINDEXED,
  title,
  transcript_text
);
