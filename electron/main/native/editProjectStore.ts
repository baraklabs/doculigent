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
  EditProjectMediaItem,
  EditProjectSource,
  LayoutEditSettings,
  OverlayConfig,
  TimelineEditSettings,
} from "@shared/types/models";
import { DEFAULT_CAMERA_EDIT_SETTINGS } from "@shared/types/models";
import { frameDimensions, toFrameCoords } from "@shared/lib/cursorFrame";
import { projectsRoot } from "./paths";
import { deleteVideo as deleteLibraryVideo, getVideo } from "./libraryStore";

function overlayToCameraSettings(overlay: OverlayConfig): CameraEditSettings {
  return {
    hidden: !overlay.showCamera,
    sizePct: Math.min(45, Math.max(10, Math.round(overlay.sizePct))),
    shape: overlay.circular ? "round" : "square",
    cornerRadiusPct: DEFAULT_CAMERA_EDIT_SETTINGS.cornerRadiusPct,
    zoomPct: DEFAULT_CAMERA_EDIT_SETTINGS.zoomPct,
    blur: overlay.cameraBlur,
    cropTopPct: DEFAULT_CAMERA_EDIT_SETTINGS.cropTopPct,
    cropRightPct: DEFAULT_CAMERA_EDIT_SETTINGS.cropRightPct,
    cropBottomPct: DEFAULT_CAMERA_EDIT_SETTINGS.cropBottomPct,
    cropLeftPct: DEFAULT_CAMERA_EDIT_SETTINGS.cropLeftPct,
    removeBackground: DEFAULT_CAMERA_EDIT_SETTINGS.removeBackground,
    muted: DEFAULT_CAMERA_EDIT_SETTINGS.muted,
    borderPct: DEFAULT_CAMERA_EDIT_SETTINGS.borderPct,
    borderColor: DEFAULT_CAMERA_EDIT_SETTINGS.borderColor,
    marquee: DEFAULT_CAMERA_EDIT_SETTINGS.marquee,
    marqueeStyle: DEFAULT_CAMERA_EDIT_SETTINGS.marqueeStyle,
    marqueeColorMode: DEFAULT_CAMERA_EDIT_SETTINGS.marqueeColorMode,
    marqueeColor: DEFAULT_CAMERA_EDIT_SETTINGS.marqueeColor,
    marqueeGradientFrom: DEFAULT_CAMERA_EDIT_SETTINGS.marqueeGradientFrom,
    marqueeGradientTo: DEFAULT_CAMERA_EDIT_SETTINGS.marqueeGradientTo,
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
  // A save from before the standalone Sound tab (and its whole-recording Sound track) were
  // retired in favor of BackgroundEditSettings.muted/CameraEditSettings.muted can still have
  // an old `sound.muted` sitting in its JSON — no longer part of the `EditProject` type at
  // all (hence the loose read here), but still worth honoring once, as the Screen tab's own
  // starting mute: the closest single-field equivalent to what that toggle used to mean, so
  // a recording exported muted before this migration doesn't quietly come back unmuted. Only
  // when `background` itself doesn't already say otherwise (a save written *after* the
  // migration, however unlikely to also carry a stale `sound`, wins on its own terms).
  const legacySoundMuted = (raw as { sound?: { muted?: boolean } }).sound?.muted === true;
  let background = raw.background;
  if (legacySoundMuted && background && !("muted" in background)) {
    background = { ...(background as BackgroundEditSettings), muted: true };
  }
  return {
    id,
    title: raw.title ?? "Untitled project",
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString(),
    source: raw.source,
    camera: raw.camera,
    cursor: raw.cursor,
    background,
    layout: raw.layout,
    timeline: raw.timeline,
    media: raw.media,
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

export function updateEditProjectMedia(id: string, media: EditProjectMediaItem[]): EditProject | null {
  const existing = readProject(id);
  if (!existing) return null;
  const updated: EditProject = { ...existing, media, updatedAt: new Date().toISOString() };
  writeExisting(updated);
  return updated;
}

// Removes the project's own source media — the library video (and its file), the picked
// file, or the raw recording folder it was built from — so "delete everything" actually
// clears the disk instead of just the project's own metadata folder.
function deleteProjectSourceFiles(source: EditProjectSource | undefined): void {
  if (!source) return;
  if (source.kind === "video" && source.videoId) {
    const video = getVideo(source.videoId);
    if (video?.filePath) {
      fs.rmSync(path.dirname(video.filePath), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    deleteLibraryVideo(source.videoId);
  } else if (source.kind === "file" && source.filePath) {
    // Only the file itself — its containing directory is wherever the user picked it
    // from, not app-managed storage, so it may hold unrelated files. Same retry budget
    // as the other two kinds below — without it, a file still momentarily held open
    // (e.g. an Edit page preview that had it loaded) throws immediately on Windows
    // instead of getting a moment to release the lock.
    fs.rmSync(source.filePath, { force: true, maxRetries: 5, retryDelay: 200 });
  } else if (source.kind === "recording" && source.recDir) {
    fs.rmSync(source.recDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

export function deleteEditProject(id: string, deleteSourceFiles?: boolean): void {
  if (deleteSourceFiles) deleteProjectSourceFiles(readProject(id)?.source);
  const dir = dirForId(id);
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  removeFromIndex(id);
}

/** Deletes every project in the batch even if one of them fails partway (a locked source
 *  file, a missing dir, etc.) — a plain loop that let the first error throw would abort
 *  the whole batch, and since the caller only finds out via the IPC call rejecting, every
 *  project *before* the failed one would have already been removed from disk/the index
 *  without the renderer ever hearing about it (no `onSuccess`, so it never refetches) —
 *  "Delete All" would look like it silently did nothing while actually leaving the
 *  library in a half-deleted state. Failures are collected and re-thrown together at the
 *  end instead, once every deletable project has actually been deleted. */
export function deleteEditProjects(ids: string[], deleteSourceFiles?: boolean): void {
  const failures: { id: string; error: unknown }[] = [];
  for (const id of ids) {
    try {
      deleteEditProject(id, deleteSourceFiles);
    } catch (error) {
      failures.push({ id, error });
    }
  }
  if (failures.length > 0) {
    const detail = failures.map(({ id, error }) => `${id}: ${error instanceof Error ? error.message : String(error)}`).join("; ");
    throw new Error(`Failed to delete ${failures.length} of ${ids.length} project(s): ${detail}`);
  }
}

const NO_MEDIA: EditProjectMedia = {
  editable: false,
  screenFilePath: null,
  cameraFilePath: null,
  singleFilePath: null,
  audioFilePath: null,
  cursorMetadataPath: null,
  cursorIconsDir: null,
  cursorBakedIn: false,
  sideClipStartOffsetMs: null,
  recordedCamera: null,
};

export function getEditProjectMedia(id: string): EditProjectMedia {
  const project = readProject(id);
  if (!project?.source) return NO_MEDIA;

  let recDir: string | null = null;
  // The "video"/"file" anchor file itself, when this source kind has one — a "recording"
  // source never does (an Advanced recording never gets composited into a single file),
  // so it's used below only as the single-file fallback's candidate for those two kinds.
  let recordingFilePath: string | null = null;
  let recordedOverlay: OverlayConfig | null = null;
  let recordedBubbleConfig: CameraBubbleConfig | null = null;
  let cursorBakedIn = false;
  let sideClipStartOffsetMs: number | null = null;

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
    if (!recordingFilePath || !fs.existsSync(recordingFilePath)) return NO_MEDIA;
    recDir = path.dirname(recordingFilePath);
  } else if (project.source.kind === "file" && project.source.filePath) {
    recordingFilePath = project.source.filePath;
    if (!fs.existsSync(recordingFilePath)) return NO_MEDIA;
    recDir = path.dirname(recordingFilePath);
  } else if (project.source.kind === "recording" && project.source.recDir) {
    // No anchor file to derive recDir from — use it directly, and recover "as recorded"
    // fidelity from recordMeta.json (written alongside the raw tracks — see
    // electron/main/ipc/recording.ts's buildEditProjectMaterials) instead of a library
    // Video row, since an Advanced-mode recording never gets one.
    if (!fs.existsSync(project.source.recDir)) return NO_MEDIA;
    recDir = project.source.recDir;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(recDir, "metadata", "recordMeta.json"), "utf-8")) as {
        overlay?: OverlayConfig;
        cursorBakedIn?: boolean;
        sideClipStartOffsetMs?: number | null;
      };
      recordedOverlay = meta.overlay ?? null;
      cursorBakedIn = !!meta.cursorBakedIn;
      sideClipStartOffsetMs = meta.sideClipStartOffsetMs ?? null;
    } catch {
      // No recordMeta.json (or unreadable) — proceed with the defaults above.
    }
  }

  if (!recDir) return NO_MEDIA;

  // Camera side clips land as `.mp4` (see buildEditProjectMaterials' writeCameraTrack,
  // which converts whatever the renderer's MediaRecorder produced into one), but `.webm`
  // still has to be resolvable: projects recorded before that conversion existed kept the
  // raw VP9/Opus container, and writeCameraTrack itself falls back to it if its ffmpeg pass
  // fails. The audio-only side clip (no camera at all) is always converted to `.wav` —
  // check all three rather than assuming one.
  function resolveMetaFile(dir: string, base: string): string | null {
    for (const ext of ["mp4", "webm", "wav"]) {
      const candidate = path.join(dir, `${base}.${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  const metaDir = path.join(recDir, "metadata");
  const screenFilePath = path.join(metaDir, "screen.mp4");
  const cameraFilePath = resolveMetaFile(metaDir, "camera");
  if (fs.existsSync(screenFilePath) && cameraFilePath) {
    const cursorMetaPath = path.join(recDir, "metadata", "cursor.json");
    const hasCursor = fs.existsSync(cursorMetaPath);
    return {
      editable: true,
      screenFilePath,
      cameraFilePath,
      singleFilePath: null,
      // A separate audio.wav is only ever written for a screen-only recording (see
      // buildEditProjectMaterials in electron/main/ipc/recording.ts) — mutually exclusive
      // with the camera track, which is what carries audio whenever a camera exists.
      audioFilePath: null,
      cursorMetadataPath: hasCursor ? cursorMetaPath : null,
      cursorIconsDir: hasCursor ? path.join(recDir, "metadata", "cursor-icons") : null,
      cursorBakedIn,
      sideClipStartOffsetMs,
      recordedCamera: recordedOverlay ? recordedCameraSettings(recordedOverlay, recDir, recordedBubbleConfig) : null,
    };
  }

  // Single-file fallback — a composited/burned-in video ("video"/"file" sources), or, for
  // a screen-only "recording" source (Advanced mode, no camera bubble), the raw screen
  // track itself: there's no separate camera to combine, so nothing was ever composited.
  const singleFileCandidate = recordingFilePath ?? (fs.existsSync(screenFilePath) ? screenFilePath : null);
  // Audio-only sources (meeting recordings, imported audio files) have no video at all.
  const isVideoFile = !!singleFileCandidate && /\.(mp4|mov|mkv|avi|webm|m4v|wmv|flv)$/i.test(singleFileCandidate);
  // A screen-only Advanced recording's own mic/system audio, kept in a separate file
  // (see buildEditProjectMaterials) since screen.mp4 (native gdigrab capture) is always
  // video-only — without this, a screen-only project (no camera.webm to carry audio
  // either) would have no audio source anywhere in the editor/export pipeline at all.
  // Only meaningful for that "recording"-source, screen-only case (recordingFilePath is
  // null there, so singleFileCandidate falls through to screenFilePath); a "video"/"file"
  // source's own single file already has any audio muxed in directly.
  const audioOnlyPath = resolveMetaFile(metaDir, "audio");
  const audioFilePath = !recordingFilePath ? audioOnlyPath : null;
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
    singleFilePath: isVideoFile ? singleFileCandidate : null,
    audioFilePath,
    cursorMetadataPath: hasCursor ? cursorMetaPath : null,
    cursorIconsDir: hasCursor ? path.join(recDir, "metadata", "cursor-icons") : null,
    cursorBakedIn,
    // Only meaningful when there's actually a side-clip audio file to place — screenFilePath
    // itself (audioFilePath null) has no separate clock to offset against.
    sideClipStartOffsetMs: audioFilePath ? sideClipStartOffsetMs : null,
    recordedCamera: null,
  };
}
