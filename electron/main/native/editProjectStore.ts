import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  BackgroundEditSettings,
  CameraBubbleConfig,
  CameraEditSettings,
  CameraTrackMetadata,
  CursorEditSettings,
  CursorMetadata,
  EditProject,
  EditProjectMedia,
  EditProjectSource,
  LayoutEditSettings,
  OverlayConfig,
  SoundEditSettings,
  TimelineEditSettings,
} from "@shared/types/models";
import { DEFAULT_CAMERA_EDIT_SETTINGS } from "@shared/types/models";
import { frameDimensions, toFrameCoords } from "@shared/lib/cursorFrame";
import { projectsRoot } from "./paths";
import { getVideo } from "./libraryStore";

function overlayToCameraSettings(overlay: OverlayConfig): CameraEditSettings {
  return {
    hidden: !overlay.showCamera,
    sizePct: Math.min(45, Math.max(10, Math.round(overlay.sizePct))),
    shape: overlay.circular ? "round" : "square",
    cornerRadiusPct: DEFAULT_CAMERA_EDIT_SETTINGS.cornerRadiusPct,
    zoomPct: DEFAULT_CAMERA_EDIT_SETTINGS.zoomPct,
    blur: overlay.cameraBlur,
  };
}

/** Builds the Camera tab's "as recorded" starting point from the actual per-frame
 *  bubble track (camera.json) rather than the legacy OverlayConfig, whose size/shape
 *  fields are no longer kept in sync with the freeform bubble window — falls back to the
 *  (coarser, but still real) OverlayConfig-derived settings when the track is missing,
 *  e.g. recordings saved before camera.json existed. */
function recordedCameraSettings(
  overlay: OverlayConfig,
  recDir: string,
  bubbleConfig: CameraBubbleConfig | null
): CameraEditSettings {
  const fallback = overlayToCameraSettings(overlay);
  try {
    const cursorMeta = JSON.parse(
      fs.readFileSync(path.join(recDir, "metadata", "cursor.json"), "utf-8")
    ) as CursorMetadata;
    const cameraMeta = JSON.parse(
      fs.readFileSync(path.join(recDir, "metadata", "camera.json"), "utf-8")
    ) as CameraTrackMetadata;
    if (cameraMeta.points.length === 0) return fallback;

    const { width: frameW, height: frameH } = frameDimensions(cursorMeta);
    const last = cameraMeta.points[cameraMeta.points.length - 1];
    const topLeft = toFrameCoords(cursorMeta, last.x, last.y);
    const bottomRight = toFrameCoords(cursorMeta, last.x + last.width, last.y + last.height);
    if (!topLeft || !bottomRight) return fallback;

    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    if (width <= 0 || height <= 0) return fallback;

    const shorter = Math.min(frameW, frameH);
    const sizePct = Math.min(45, Math.max(10, Math.round((Math.min(width, height) / shorter) * 100)));

    return {
      ...fallback,
      sizePct,
      shape: bubbleConfig?.shape ?? fallback.shape,
      cornerRadiusPct: bubbleConfig
        ? bubbleConfig.roundedCorners
          ? DEFAULT_CAMERA_EDIT_SETTINGS.cornerRadiusPct
          : 0
        : fallback.cornerRadiusPct,
      blur: bubbleConfig?.blur ?? fallback.blur,
    };
  } catch {
    return fallback;
  }
}

// Each project's own folder lives centrally under the projects dir, at
// <projectsRoot>/<id>, alongside the index at <projectsRoot>/index.json (a
// pointer table of id -> dir), rather than beside the source recording — so
// projects don't scatter across arbitrary picked-file locations on disk.
interface ProjectIndexEntry {
  id: string;
  dir: string;
}

function fallbackProjectsRoot(): string {
  return projectsRoot();
}

function indexFile(): string {
  return path.join(fallbackProjectsRoot(), "index.json");
}

function readIndex(): ProjectIndexEntry[] {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), "utf-8")) as ProjectIndexEntry[];
  } catch {
    return [];
  }
}

function writeIndex(entries: ProjectIndexEntry[]): void {
  const file = indexFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries), "utf-8");
  fs.renameSync(tmp, file);
}

function addToIndex(entry: ProjectIndexEntry): void {
  writeIndex([...readIndex().filter((e) => e.id !== entry.id), entry]);
}

function removeFromIndex(id: string): void {
  writeIndex(readIndex().filter((e) => e.id !== id));
}

function dirForId(id: string): string | null {
  return readIndex().find((e) => e.id === id)?.dir ?? null;
}

function newProjectDir(id: string): string {
  return path.join(fallbackProjectsRoot(), id);
}

function projectJsonFile(dir: string): string {
  return path.join(dir, "project.json");
}

// One-time upgrade for projects saved before the index existed: migrates each
// legacy <projectsRoot>/metadata/<id>.json into <projectsRoot>/<id>/project.json
// and records it in the index, so existing projects don't go missing after the update.
let legacyMigrationChecked = false;
function migrateLegacyProjectsOnce(): void {
  if (legacyMigrationChecked) return;
  legacyMigrationChecked = true;
  const legacyMetadataDir = path.join(fallbackProjectsRoot(), "metadata");
  let files: string[];
  try {
    files = fs.readdirSync(legacyMetadataDir).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  if (files.length === 0) return;

  const index = readIndex();
  const knownIds = new Set(index.map((e) => e.id));
  let changed = false;
  for (const file of files) {
    const id = file.slice(0, -".json".length);
    if (knownIds.has(id)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(legacyMetadataDir, file), "utf-8")) as Partial<EditProject>;
      const project = normalize(id, raw);
      const dir = newProjectDir(id);
      writeProject(project, dir);
      fs.rmSync(path.join(legacyMetadataDir, file), { force: true });
      index.push({ id, dir });
      knownIds.add(id);
      changed = true;
    } catch (e) {
      console.error(`Couldn't migrate legacy edit project ${id}:`, e);
    }
  }
  if (changed) writeIndex(index);
}

function normalize(id: string, raw: Partial<EditProject>): EditProject {
  return {
    id,
    title: raw.title ?? "Untitled project",
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString(),
    source: raw.source,
    camera: raw.camera,
    cursor: raw.cursor,
    background: raw.background,
    sound: raw.sound,
    layout: raw.layout,
    timeline: raw.timeline,
  };
}

function readProject(id: string): EditProject | null {
  const dir = dirForId(id);
  if (!dir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(projectJsonFile(dir), "utf-8")) as Partial<EditProject>;
    return normalize(id, raw);
  } catch {
    return null;
  }
}

function writeProject(project: EditProject, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = projectJsonFile(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

// Writes an update to a project that's already indexed — its dir is already known.
function writeExisting(project: EditProject): void {
  const dir = dirForId(project.id);
  if (!dir) return;
  writeProject(project, dir);
}

export function listEditProjects(): EditProject[] {
  migrateLegacyProjectsOnce();
  return readIndex()
    .map((e) => readProject(e.id))
    .filter((p): p is EditProject => p !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getEditProject(id: string): EditProject | null {
  migrateLegacyProjectsOnce();
  return readProject(id);
}

export function createEditProject(title: string, source?: EditProjectSource): EditProject {
  migrateLegacyProjectsOnce();
  const now = new Date().toISOString();
  const id = randomUUID();
  const project: EditProject = {
    id,
    title: title.trim() || "Untitled project",
    createdAt: now,
    updatedAt: now,
    source,
  };
  const dir = newProjectDir(id);
  writeProject(project, dir);
  addToIndex({ id, dir });
  return project;
}

export function renameEditProject(id: string, title: string): EditProject | null {
  const existing = readProject(id);
  if (!existing) return null;
  const updated: EditProject = { ...existing, title: title.trim() || "Untitled project", updatedAt: new Date().toISOString() };
  writeExisting(updated);
  return updated;
}

export function updateEditProjectCamera(id: string, camera: CameraEditSettings): EditProject | null {
  const existing = readProject(id);
  if (!existing) return null;
  const updated: EditProject = { ...existing, camera, updatedAt: new Date().toISOString() };
  writeExisting(updated);
  return updated;
}

export function updateEditProjectCursor(id: string, cursor: CursorEditSettings): EditProject | null {
  const existing = readProject(id);
  if (!existing) return null;
  const updated: EditProject = { ...existing, cursor, updatedAt: new Date().toISOString() };
  writeExisting(updated);
  return updated;
}

export function updateEditProjectBackground(id: string, background: BackgroundEditSettings): EditProject | null {
  const existing = readProject(id);
  if (!existing) return null;
  const updated: EditProject = { ...existing, background, updatedAt: new Date().toISOString() };
  writeExisting(updated);
  return updated;
}

export function updateEditProjectSound(id: string, sound: SoundEditSettings): EditProject | null {
  const existing = readProject(id);
  if (!existing) return null;
  const updated: EditProject = { ...existing, sound, updatedAt: new Date().toISOString() };
  writeExisting(updated);
  return updated;
}

export function updateEditProjectLayout(id: string, layout: LayoutEditSettings): EditProject | null {
  const existing = readProject(id);
  if (!existing) return null;
  const updated: EditProject = { ...existing, layout, updatedAt: new Date().toISOString() };
  writeExisting(updated);
  return updated;
}

export function updateEditProjectTimeline(id: string, timeline: TimelineEditSettings): EditProject | null {
  const existing = readProject(id);
  if (!existing) return null;
  const updated: EditProject = { ...existing, timeline, updatedAt: new Date().toISOString() };
  writeExisting(updated);
  return updated;
}

export function deleteEditProject(id: string): void {
  const dir = dirForId(id);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  removeFromIndex(id);
}

export function deleteEditProjects(ids: string[]): void {
  for (const id of ids) deleteEditProject(id);
}

const NO_MEDIA: EditProjectMedia = {
  editable: false,
  screenFilePath: null,
  cameraFilePath: null,
  singleFilePath: null,
  cursorMetadataPath: null,
  cursorIconsDir: null,
  cursorBakedIn: false,
  recordedCamera: null,
};

export function getEditProjectMedia(id: string): EditProjectMedia {
  const project = readProject(id);
  if (!project?.source) return NO_MEDIA;

  let recordingFilePath: string | null = null;
  let recordedOverlay: OverlayConfig | null = null;
  let recordedBubbleConfig: CameraBubbleConfig | null = null;
  let cursorBakedIn = false;
  if (project.source.kind === "video" && project.source.videoId) {
    const video = getVideo(project.source.videoId);
    recordingFilePath = video?.filePath ?? null;
    recordedOverlay = video?.overlay ?? null;
    recordedBubbleConfig = video?.cameraBubbleConfig ?? null;
    cursorBakedIn = !!video?.cursorBakedIn;
    console.log("[editProjectStore] getEditProjectMedia", {
      projectId: id,
      videoId: project.source.videoId,
      videoFound: !!video,
      filePath: video?.filePath,
      cursorBakedIn: video?.cursorBakedIn,
    });
  } else if (project.source.kind === "file" && project.source.filePath) {
    recordingFilePath = project.source.filePath;
  }
  if (!recordingFilePath || !fs.existsSync(recordingFilePath)) return NO_MEDIA;

  const recDir = path.dirname(recordingFilePath);
  const screenFilePath = path.join(recDir, "metadata", "screen.mp4");
  const cameraFilePath = path.join(recDir, "metadata", "camera.webm");
  if (fs.existsSync(screenFilePath) && fs.existsSync(cameraFilePath)) {
    const cursorMetaPath = path.join(recDir, "metadata", "cursor.json");
    const hasCursor = fs.existsSync(cursorMetaPath);
    return {
      editable: true,
      screenFilePath,
      cameraFilePath,
      singleFilePath: null,
      cursorMetadataPath: hasCursor ? cursorMetaPath : null,
      cursorIconsDir: hasCursor ? path.join(recDir, "metadata", "cursor-icons") : null,
      cursorBakedIn,
      recordedCamera: recordedOverlay ? recordedCameraSettings(recordedOverlay, recDir, recordedBubbleConfig) : null,
    };
  }

  // Audio-only sources (meeting recordings, imported audio files) have no video at all.
  const isVideoFile = /\.(mp4|mov|mkv|avi|webm|m4v|wmv|flv)$/i.test(recordingFilePath);
  // Position tracking (cursor.json) runs regardless of platform, independent of whether
  // screen/camera were split into their own files — only icon *capture* is Windows-only,
  // and that already degrades to a synthetic fallback arrow (see native/cursorIcon.ts).
  // Surfacing it here too (not just in the split-file branch above) is what lets the Edit
  // page's cursor-replacement styles (arrow/circle/hand) render on a single-file recording.
  const cursorMetaPath = path.join(recDir, "metadata", "cursor.json");
  const hasCursor = isVideoFile && fs.existsSync(cursorMetaPath);
  return {
    editable: false,
    screenFilePath: null,
    cameraFilePath: null,
    singleFilePath: isVideoFile ? recordingFilePath : null,
    cursorMetadataPath: hasCursor ? cursorMetaPath : null,
    cursorIconsDir: hasCursor ? path.join(recDir, "metadata", "cursor-icons") : null,
    cursorBakedIn,
    recordedCamera: null,
  };
}
