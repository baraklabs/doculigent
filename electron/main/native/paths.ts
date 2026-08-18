
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const RECORDINGS_DIR_POINTER_FILE = path.join(app.getPath("userData"), "recordings-dir.json");
const MEETINGS_DIR_POINTER_FILE = path.join(app.getPath("userData"), "meetings-dir.json");
const PROJECTS_DIR_POINTER_FILE = path.join(app.getPath("userData"), "projects-dir.json");
const TEAMS_DIR_POINTER_FILE = path.join(app.getPath("userData"), "teams-dir.json");

function doculigentRoot(): string {
  return path.join(app.getPath("home"), "Doculigent");
}

function readDirPointer(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as { dir?: string };
    return parsed.dir ?? null;
  } catch {
    return null;
  }
}

function writeDirPointer(file: string, dir: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dir }));
}

// Recordings, meetings, edit projects, and team/shared files each have their own
// independently overridable save location — changing one must not affect the
// others — defaulting to their own subfolder under the user profile's Doculigent
// folder until the user picks somewhere else.
export function getRecordingsDir(): string {
  return readDirPointer(RECORDINGS_DIR_POINTER_FILE) ?? path.join(doculigentRoot(), "Recordings");
}

export function setRecordingsDir(dir: string): void {
  writeDirPointer(RECORDINGS_DIR_POINTER_FILE, dir);
}

export function recordingsRoot(): string {
  const dir = getRecordingsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getMeetingsDir(): string {
  return readDirPointer(MEETINGS_DIR_POINTER_FILE) ?? path.join(doculigentRoot(), "Meetings");
}

export function setMeetingsDir(dir: string): void {
  writeDirPointer(MEETINGS_DIR_POINTER_FILE, dir);
}

export function meetingsRoot(): string {
  const dir = getMeetingsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getProjectsDir(): string {
  return readDirPointer(PROJECTS_DIR_POINTER_FILE) ?? path.join(doculigentRoot(), "Projects");
}

export function setProjectsDir(dir: string): void {
  writeDirPointer(PROJECTS_DIR_POINTER_FILE, dir);
}

export function projectsRoot(): string {
  const dir = getProjectsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTeamsDir(): string {
  return readDirPointer(TEAMS_DIR_POINTER_FILE) ?? path.join(doculigentRoot(), "Teams");
}

export function setTeamsDir(dir: string): void {
  writeDirPointer(TEAMS_DIR_POINTER_FILE, dir);
}

function teamsRoot(): string {
  const dir = getTeamsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function teamFileDir(teamId: string, fileId: string): string {
  return path.join(teamsRoot(), teamId, fileId);
}

export function settingsFilePath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function libraryStoreFilePath(): string {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "library.json");
}

export function shareLinksFilePath(): string {
  return path.join(app.getPath("userData"), "share-links.json");
}
