/**
 * Where things live on disk:
 *  - App data (settings.json, database.sqlite, the save-dir pointer itself) lives in
 *    Electron's standard per-app userData directory (e.g. `%APPDATA%\Doculigent` on
 *    Windows, `~/Library/Application Support/Doculigent` on macOS) — the same place
 *    Claude Desktop, VS Code, Slack, etc. keep their app-level config/db. Not
 *    user-relocatable, not meant to be browsed by hand.
 *  - Video files go in a separate, user-visible, user-relocatable "save to" folder
 *    (default: the OS Videos folder + "Doculigent"), matching FUNCTIONALITY.md §8 — this
 *    is the one location the Record tab's "Save to" / "Browse…" control changes.
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const SAVE_DIR_POINTER_FILE = path.join(app.getPath("userData"), "save-dir.json");

function defaultSaveDir(): string {
  return path.join(app.getPath("videos"), "Doculigent");
}

export function getSaveDir(): string {
  try {
    const raw = fs.readFileSync(SAVE_DIR_POINTER_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { saveDir?: string };
    if (parsed.saveDir) return parsed.saveDir;
  } catch {
    // No pointer file yet (first run) or it's unreadable — fall back to the default.
  }
  return defaultSaveDir();
}

export function setSaveDir(dir: string): void {
  fs.mkdirSync(path.dirname(SAVE_DIR_POINTER_FILE), { recursive: true });
  fs.writeFileSync(SAVE_DIR_POINTER_FILE, JSON.stringify({ saveDir: dir }));
}

/** Ensures the video save directory exists; returns it. */
export function ensureSaveDir(): string {
  const dir = getSaveDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function databaseFilePath(): string {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "database.sqlite");
}
