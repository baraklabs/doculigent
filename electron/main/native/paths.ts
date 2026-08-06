
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
  }
  return defaultSaveDir();
}

export function setSaveDir(dir: string): void {
  fs.mkdirSync(path.dirname(SAVE_DIR_POINTER_FILE), { recursive: true });
  fs.writeFileSync(SAVE_DIR_POINTER_FILE, JSON.stringify({ saveDir: dir }));
}

export function ensureSaveDir(): string {
  const dir = getSaveDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function teamFileDir(teamId: string, fileId: string): string {
  return path.join(app.getPath("documents"), "Doculigent", teamId, fileId);
}

export function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function libraryStoreFilePath(): string {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "library.json");
}
