import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Camera,
  MousePointer2,
  ImageIcon,
  LayoutTemplate,
  Sparkles,
  FolderOpen,
  Upload,
  Check,
  Loader2,
  GripHorizontal,
  FileVideo,
  FileAudio,
  Plus,
  X,
  type LucideIcon,
} from "lucide-react";
import { CameraEditPanel } from "../components/CameraEditPanel";
import { CursorEditPanel } from "../components/CursorEditPanel";
import { BackgroundEditPanel } from "../components/BackgroundEditPanel";
import { LayoutEditPanel } from "../components/LayoutEditPanel";
import { ExtVideoEditPanel } from "../components/ExtVideoEditPanel";
import { ExtSoundEditPanel } from "../components/ExtSoundEditPanel";
import { EffectsEditPanel, type EffectsNavKind } from "../components/EffectsEditPanel";
import { MASTER_CUT_ID, type CutChipRailCut } from "../components/CutChipRail";
import { PreviewCompositor, type PreviewCompositorHandle } from "../components/PreviewCompositor";
import { ExportDialog } from "../components/ExportDialog";
import { MEDIA_DRAG_MIME_PREFIX, Timeline, type TimelineTool, type TrackKind } from "../components/Timeline";
import {
  useCreateEditProject,
  useEditProject,
  useEditProjectMedia,
  useRenameEditProject,
  useUpdateEditProjectBackground,
  useUpdateEditProjectCamera,
  useUpdateEditProjectCursor,
  useUpdateEditProjectLayout,
  useUpdateEditProjectMedia,
  useUpdateEditProjectTimeline,
} from "../hooks/useEditProjects";
import {
  DEFAULT_BACKGROUND_EDIT_SETTINGS,
  DEFAULT_CAMERA_EDIT_SETTINGS,
  DEFAULT_CURSOR_EDIT_SETTINGS,
  ORIGINAL_CURSOR_EDIT_SETTINGS,
  DEFAULT_EXT_VIDEO_EDIT_SETTINGS,
  DEFAULT_LAYOUT_EDIT_SETTINGS,
  DEFAULT_TIMELINE_EDIT_SETTINGS,
  type BackgroundEditSettings,
  type CameraEditSettings,
  type CursorEditSettings,
  type EditProjectMediaItem,
  type ExtVideoEditSettings,
  type LayoutEditSettings,
  type TimelineClip,
  type TimelineEditSettings,
  type TimelineEffect,
  type TimelineEffectBox,
  type TimelineEffectKind,
  type TimelineMediaClip,
  type TimelineSegment,
  type TimelineZoom,
  type TimelineZoomStyle,
  type TimelineZoomTilt,
  ZOOM_DEFAULT_DURATION_MS,
  ZOOM_DEFAULT_PCT,
  ZOOM_LEAD_MS,
} from "@shared/types/models";
import { effectiveClips } from "@shared/lib/timelineClips";
import { buildMediaItems } from "../lib/editMedia";
import { EditProjectService } from "../services/editProjects/EditProjectService";
import { setSegmentSettings } from "@shared/lib/timelineSegments";
import {
  DEFAULT_NEW_ZOOM_STYLE,
  DEFAULT_NEW_ZOOM_TILT,
  normalizeTimelineZooms,
  removeZoom as removeZoomLib,
  setZoomPct as setZoomPctLib,
  setZoomStyle as setZoomStyleLib,
  setZoomTilt as setZoomTiltLib,
} from "@shared/lib/timelineZooms";
import {
  EFFECT_DEFAULT_DURATION_MS,
  MIN_EFFECT_MS,
  addEffect as addEffectLib,
  createEffect,
  normalizeTimelineEffects,
  removeEffect as removeEffectLib,
  updateEffect as updateEffectLib,
} from "@shared/lib/timelineEffects";
import "./EditPage.css";

type EditTab = "camera" | "cursor" | "background" | "layout" | "effects" | "extVideo" | "extSound";

/** A fresh project's (and "Reset to default"'s) starting crop — trims off roughly where
 *  this platform's own OS chrome sits, so an unedited recording doesn't show it by
 *  default: macOS's menu bar (top) and Dock (bottom) get their own independent crops,
 *  Windows/Linux just the one (taskbar, bottom). This is the *only* place that crop
 *  happens — capturing at the source (the display's OS-reported work area instead of its
 *  full bounds) was tried and reverted: it permanently discards those pixels, so unchecking
 *  BackgroundEditPanel's "Remove taskbar"/"Remove menu bar"/"Remove Dock" toggle could
 *  never actually bring them back (confirmed against a real recording that came out
 *  1920x1020, the Windows taskbar's ~60px already gone with no way to restore it short of
 *  re-recording — see native/screenCapture.ts's startScreenCapture for that revert).
 *  Cropping here instead, at edit time, is fully reversible. Same preset amounts as
 *  BackgroundEditPanel's own OS_CHROME_CROPS, which start checked to match this. */
function defaultBackgroundEditSettingsForPlatform(): BackgroundEditSettings {
  if (window.api.system.platform === "darwin") {
    return { ...DEFAULT_BACKGROUND_EDIT_SETTINGS, cropTopPct: 3, cropBottomPct: 6 };
  }
  return { ...DEFAULT_BACKGROUND_EDIT_SETTINGS, cropBottomPct: 4 };
}

interface EditSnapshot {
  camera: CameraEditSettings;
  cursor: CursorEditSettings;
  background: BackgroundEditSettings;
  layout: LayoutEditSettings;
  timeline: TimelineEditSettings;
}

const TABS: { id: EditTab; label: string; icon: LucideIcon }[] = [
  { id: "background", label: "Screen", icon: ImageIcon },
  { id: "cursor", label: "Cursor", icon: MousePointer2 },
  { id: "camera", label: "Camera", icon: Camera },
  { id: "layout", label: "Layout", icon: LayoutTemplate },
  { id: "effects", label: "Effects", icon: Sparkles },
  { id: "extVideo", label: "Ext Video", icon: FileVideo },
  { id: "extSound", label: "Ext Sound", icon: FileAudio },
];

/** Maps an edit tab to the Timeline track it edits — used for the Timeline's `activeTrack`
 *  row highlight. There's no standalone Sound tab any more (see BackgroundEditPanel/
 *  CameraEditPanel's own Audio section) — audio mute lives on the Screen and Camera tabs
 *  themselves, so it just rides along with the "clips"/"camera" entries already here.
 *  Effects is undefined *here* because it's the one tab owning three rows (Zoom, Callout and
 *  Blur) rather than one — which of them lights up follows `effectsNavKind` instead,
 *  resolved at the render site. */
const TAB_TRACK: Record<EditTab, TrackKind | undefined> = {
  background: "clips",
  cursor: "cursor",
  camera: "camera",
  layout: "layout",
  effects: undefined,
  extVideo: "video",
  extSound: "audio",
};

/** Chip-rail entries for a Clips/Camera track's real cuts (raw `clips`/`cameraClips` —
 *  NOT effectiveClips' fabricated single-piece default, which would otherwise show a
 *  phantom "Cut 1" for a track that hasn't actually been split yet). Sorted by
 *  `timelineStart` so the numbering stays stable/meaningful even though the underlying
 *  array's own order doubles as z-stacking order (see TimelineClip's doc comment). */
function clipCuts(clips: TimelineClip[], overrides: Record<string, unknown>): CutChipRailCut[] {
  return [...clips]
    .sort((a, b) => a.timelineStart - b.timelineStart)
    .map((c, i) => ({ id: c.id, label: `Cut ${i + 1}`, hasOverride: c.id in overrides }));
}

/** Chip-rail entries for a Cursor/Layout track's real segments (raw, same "empty means not
 *  cut yet" convention as clipCuts above) — already in timeline order by construction
 *  (splitSegmentAtPoint/deleteSegment never reorder). */
function segmentCuts<T>(segments: TimelineSegment<T>[]): CutChipRailCut[] {
  return segments.map((s, i) => ({ id: s.id, label: `Cut ${i + 1}`, hasOverride: s.settings !== null }));
}
const EDIT_TAB_IDS = TABS.map((t) => t.id) as readonly string[];

// Constrain drag so neither pane can be squeezed to uselessness.
const MIN_TOP_PCT = 30;
const MAX_TOP_PCT = 80;
const MIN_LEFT_PCT = 22;
const MAX_LEFT_PCT = 60;
const DEFAULT_TOP_PCT = 60;
const DEFAULT_LEFT_PCT = 40;

const DEFAULT_TITLE = "Untitled project";
const TOP_PCT_KEY = "editPage.topPct";
const LEFT_PCT_KEY = "editPage.leftPct";
const LAST_PROJECT_KEY = "editPage.lastProjectId";
const LAST_TAB_KEY = "editPage.lastTab";
const TITLE_SAVE_DEBOUNCE_MS = 700;

const AUDIO_PATH_RE = /\.(mp3|wav|m4a|aac|ogg|flac)$/i;

/** m:ss for an added media file's own length, shown on its card in the Media panel. */
function formatMediaDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalSecs = Math.round(ms / 1000);
  return `${Math.floor(totalSecs / 60)}:${(totalSecs % 60).toString().padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function readStoredPct(key: string, fallback: number, min: number, max: number) {
  const n = parseFloat(localStorage.getItem(key) ?? "");
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

export function EditPage() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { data: project, isLoading: projectLoading } = useEditProject(id);
  const { data: media, isLoading: mediaLoading } = useEditProjectMedia(id);

  // Set when the main process is about to delete this exact project's files — a delete
  // triggered from Library while this Edit page still has it open can otherwise race a
  // `<video>` element that's actively holding the file open (see onReleaseMedia's own
  // comment in api.ts). Forces the preview below to unmount immediately instead of
  // waiting for a route change, so the delete's retry-and-unlink isn't fighting a still-
  // live media element. Reset whenever the route's own project changes.
  const [mediaReleased, setMediaReleased] = useState(false);
  useEffect(() => {
    setMediaReleased(false);
  }, [id]);
  useEffect(() => {
    return window.api.editProjects.onReleaseMedia((ids) => {
      if (id && ids.includes(id)) setMediaReleased(true);
    });
  }, [id]);
  const createProject = useCreateEditProject();
  const renameProject = useRenameEditProject();
  const updateCamera = useUpdateEditProjectCamera();
  const updateCursor = useUpdateEditProjectCursor();
  const updateBackground = useUpdateEditProjectBackground();
  const updateLayout = useUpdateEditProjectLayout();
  const updateTimeline = useUpdateEditProjectTimeline();
  const updateMedia = useUpdateEditProjectMedia();

  const [title, setTitle] = useState(DEFAULT_TITLE);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  const [camera, setCamera] = useState<CameraEditSettings>(DEFAULT_CAMERA_EDIT_SETTINGS);
  const cameraLoadedForIdRef = useRef<string | undefined>(undefined);
  // A fresh recording's starting point is the same DEFAULT_CAMERA_EDIT_SETTINGS every other
  // untouched project starts from, not how the camera happened to be configured live at
  // record time — that as-recorded config (media.recordedCamera) is still what "Reset to
  // original" restores (see originalCamera/resetAllToOriginal below), just not the opening
  // default anymore. Still waits on `media` purely so this doesn't race the media fetch.
  useEffect(() => {
    if (id && project && media && cameraLoadedForIdRef.current !== id) {
      // Merged with defaults, not just falling back to them wholesale — see the identical
      // note on background below (project.background ?? ...).
      setCamera({ ...DEFAULT_CAMERA_EDIT_SETTINGS, ...(project.camera ?? {}) });
      cameraLoadedForIdRef.current = id;
    }
  }, [id, project, media]);

  const cameraSaveTimerRef = useRef<number | null>(null);
  const cameraPendingRef = useRef<CameraEditSettings | null>(null);
  function handleCameraChange(next: CameraEditSettings) {
    commitHistoryChange();
    setCamera(next);
    if (!id) return;
    cameraPendingRef.current = next;
    if (cameraSaveTimerRef.current) window.clearTimeout(cameraSaveTimerRef.current);
    cameraSaveTimerRef.current = window.setTimeout(() => {
      cameraPendingRef.current = null;
      updateCamera.mutate({ id, camera: next });
    }, 500);
  }
  // Best-effort flush so navigating away within the debounce window (e.g. right after
  // clicking Reset) doesn't silently drop the change instead of saving it.
  useEffect(() => {
    return () => {
      if (cameraSaveTimerRef.current) window.clearTimeout(cameraSaveTimerRef.current);
      if (cameraPendingRef.current && loadedForIdRef.current) {
        updateCamera.mutate({ id: loadedForIdRef.current, camera: cameraPendingRef.current });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [cursor, setCursor] = useState<CursorEditSettings>(DEFAULT_CURSOR_EDIT_SETTINGS);
  const cursorLoadedForIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (id && project && cursorLoadedForIdRef.current !== id) {
      // Merged with defaults, not just falling back to them wholesale — projects saved
      // before `hidden` existed still have a `cursor` object, just missing that field.
      setCursor({ ...DEFAULT_CURSOR_EDIT_SETTINGS, ...(project.cursor ?? {}) });
      cursorLoadedForIdRef.current = id;
    }
  }, [id, project]);

  const cursorSaveTimerRef = useRef<number | null>(null);
  const cursorPendingRef = useRef<CursorEditSettings | null>(null);
  function handleCursorChange(next: CursorEditSettings) {
    commitHistoryChange();
    setCursor(next);
    if (!id) return;
    cursorPendingRef.current = next;
    if (cursorSaveTimerRef.current) window.clearTimeout(cursorSaveTimerRef.current);
    cursorSaveTimerRef.current = window.setTimeout(() => {
      cursorPendingRef.current = null;
      updateCursor.mutate({ id, cursor: next });
    }, 500);
  }
  useEffect(() => {
    return () => {
      if (cursorSaveTimerRef.current) window.clearTimeout(cursorSaveTimerRef.current);
      if (cursorPendingRef.current && loadedForIdRef.current) {
        updateCursor.mutate({ id: loadedForIdRef.current, cursor: cursorPendingRef.current });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [background, setBackground] = useState<BackgroundEditSettings>(defaultBackgroundEditSettingsForPlatform);
  const backgroundLoadedForIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (id && project && backgroundLoadedForIdRef.current !== id) {
      // Merged with the platform default, not just falling back to it wholesale —
      // projects saved before newer fields (e.g. crop) existed still have a `background`
      // object, just missing those keys; a genuinely new project (background entirely
      // absent) gets the platform default's crop as its starting point.
      setBackground({ ...defaultBackgroundEditSettingsForPlatform(), ...(project.background ?? {}) });
      backgroundLoadedForIdRef.current = id;
    }
  }, [id, project]);

  const backgroundSaveTimerRef = useRef<number | null>(null);
  const backgroundPendingRef = useRef<BackgroundEditSettings | null>(null);
  function handleBackgroundChange(next: BackgroundEditSettings) {
    commitHistoryChange();
    setBackground(next);
    if (!id) return;
    backgroundPendingRef.current = next;
    if (backgroundSaveTimerRef.current) window.clearTimeout(backgroundSaveTimerRef.current);
    backgroundSaveTimerRef.current = window.setTimeout(() => {
      backgroundPendingRef.current = null;
      updateBackground.mutate({ id, background: next });
    }, 500);
  }
  useEffect(() => {
    return () => {
      if (backgroundSaveTimerRef.current) window.clearTimeout(backgroundSaveTimerRef.current);
      if (backgroundPendingRef.current && loadedForIdRef.current) {
        updateBackground.mutate({ id: loadedForIdRef.current, background: backgroundPendingRef.current });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [layout, setLayout] = useState<LayoutEditSettings>(DEFAULT_LAYOUT_EDIT_SETTINGS);
  const layoutLoadedForIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (id && project && layoutLoadedForIdRef.current !== id) {
      // Merged with defaults, not just falling back to them wholesale — projects saved
      // before the landscape/reel arrangement fields existed still have a `layout` object,
      // just missing those newer keys.
      setLayout({ ...DEFAULT_LAYOUT_EDIT_SETTINGS, ...(project.layout ?? {}) });
      layoutLoadedForIdRef.current = id;
    }
  }, [id, project]);

  const layoutSaveTimerRef = useRef<number | null>(null);
  const layoutPendingRef = useRef<LayoutEditSettings | null>(null);
  function handleLayoutChange(next: LayoutEditSettings) {
    commitHistoryChange();
    setLayout(next);
    if (!id) return;
    layoutPendingRef.current = next;
    if (layoutSaveTimerRef.current) window.clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = window.setTimeout(() => {
      layoutPendingRef.current = null;
      updateLayout.mutate({ id, layout: next });
    }, 500);
  }
  useEffect(() => {
    return () => {
      if (layoutSaveTimerRef.current) window.clearTimeout(layoutSaveTimerRef.current);
      if (layoutPendingRef.current && loadedForIdRef.current) {
        updateLayout.mutate({ id: loadedForIdRef.current, layout: layoutPendingRef.current });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [timeline, setTimeline] = useState<TimelineEditSettings>(DEFAULT_TIMELINE_EDIT_SETTINGS);
  const timelineLoadedForIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (id && project && timelineLoadedForIdRef.current !== id) {
      // Merged with defaults, not just falling back to them wholesale — projects saved
      // before cameraHides existed still have a `timeline` object, just missing that field.
      // normalizeTimelineZooms back-fills fields added to TimelineZoom itself after some
      // projects were already saved (style, and pct's clamp range) — the spread above only
      // fills in a missing top-level key, not fields missing from existing zoom entries.
      setTimeline({
        ...DEFAULT_TIMELINE_EDIT_SETTINGS,
        ...(project.timeline ?? {}),
        zooms: normalizeTimelineZooms(project.timeline?.zooms ?? []),
        // Same reasoning as normalizeTimelineZooms above, for the Effects tab's boxes.
        effects: normalizeTimelineEffects(project.timeline?.effects ?? []),
      });
      timelineLoadedForIdRef.current = id;
    }
  }, [id, project]);

  const timelineSaveTimerRef = useRef<number | null>(null);
  const timelinePendingRef = useRef<TimelineEditSettings | null>(null);
  function handleTimelineChange(next: TimelineEditSettings) {
    commitHistoryChange();
    setTimeline(next);
    if (!id) return;
    timelinePendingRef.current = next;
    if (timelineSaveTimerRef.current) window.clearTimeout(timelineSaveTimerRef.current);
    timelineSaveTimerRef.current = window.setTimeout(() => {
      timelinePendingRef.current = null;
      updateTimeline.mutate({ id, timeline: next });
    }, 500);
  }
  useEffect(() => {
    return () => {
      if (timelineSaveTimerRef.current) window.clearTimeout(timelineSaveTimerRef.current);
      if (timelinePendingRef.current && loadedForIdRef.current) {
        updateTimeline.mutate({ id: loadedForIdRef.current, timeline: timelinePendingRef.current });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The project's added-media pool — audio/video files the user attached from the Media
  // panel, which the Timeline's Video/Audio tracks place pieces from (see
  // EditProjectMediaItem). Deliberately *not* part of EditSnapshot/the undo history:
  // Ctrl+Z is for the edit, and attaching or detaching a file isn't one. Everything that is
  // an edit — where a piece sits, how it's trimmed, whether it's there at all — lives in
  // `timeline` and undoes normally.
  const [mediaItems, setMediaItems] = useState<EditProjectMediaItem[]>([]);
  const mediaItemsLoadedForIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (id && project && mediaItemsLoadedForIdRef.current !== id) {
      setMediaItems(project.media ?? []);
      mediaItemsLoadedForIdRef.current = id;
    }
  }, [id, project]);

  // Saved straight away rather than through the 500ms debounce the settings tabs use —
  // adding or removing a file is one discrete action, not a stream of slider ticks.
  function persistMediaItems(next: EditProjectMediaItem[]) {
    setMediaItems(next);
    if (id) updateMedia.mutate({ id, media: next });
  }

  function newMediaClip(item: EditProjectMediaItem, atMs: number): TimelineMediaClip {
    return {
      id: crypto.randomUUID(),
      mediaId: item.id,
      sourceStart: 0,
      sourceEnd: item.durationMs,
      timelineStart: Math.max(0, atMs),
    };
  }

  /** Where the edited timeline currently ends. `previewMs.durationMs` is the compositor's
   *  own authoritative extent, but it only catches up a frame after an edit — so the media
   *  tracks' own rightmost edges are folded in directly from state too. Without that, adding
   *  two files in quick succession would place the second one on top of the first, having
   *  read a duration that predates it. */
  function timelineEndMs(): number {
    const pieceEnd = (c: TimelineMediaClip) => c.timelineStart + Math.max(0, c.sourceEnd - c.sourceStart);
    return Math.max(
      previewMs.durationMs,
      ...timeline.videoClips.map(pieceEnd),
      ...timeline.audioClips.map(pieceEnd)
    );
  }

  /** Adds items to the project's pool and drops a piece of each onto the track its own kind
   *  belongs to, starting at `atMs` — so one batch of mixed audio and video splits across
   *  both tracks, and several files of the same kind lay out end to end instead of all
   *  piling onto the same instant. An unreadable file still joins the pool (it shows there as
   *  such) but has no length to place. */
  function addMediaItemsAt(items: EditProjectMediaItem[], atMs: number) {
    persistMediaItems([...mediaItems, ...items]);
    const videoClips = [...timeline.videoClips];
    const audioClips = [...timeline.audioClips];
    const nextStartMs = { video: Math.max(0, atMs), audio: Math.max(0, atMs) };
    for (const item of items) {
      if (item.durationMs <= 0) continue;
      const clip = newMediaClip(item, nextStartMs[item.kind]);
      if (item.kind === "video") videoClips.push(clip);
      else audioClips.push(clip);
      nextStartMs[item.kind] += item.durationMs;
    }
    handleTimelineChange({ ...timeline, videoClips, audioClips });
  }

  const [addingMedia, setAddingMedia] = useState(false);
  /** The Media panel's "Add media" box — picked files join the pool *and* land on the
   *  timeline straight away, appended after everything already on it, so adding one is a
   *  single action rather than "add it, then go find it and place it." Anywhere else is a
   *  drag away (or the box's own "at playhead" button). */
  async function handlePickMediaFiles() {
    setAddingMedia(true);
    try {
      const filePaths = await EditProjectService.pickMediaFiles();
      if (filePaths.length === 0) return;
      const items = await buildMediaItems(filePaths);
      if (items.length > 0) addMediaItemsAt(items, timelineEndMs());
    } finally {
      setAddingMedia(false);
    }
  }

  /** Files dragged onto an Ext Video/Ext Audio track straight from the OS — they have to
   *  join the pool before anything can be placed from them, which is why the Timeline hands
   *  them back up here rather than handling the drop itself. Unlike the picker above these
   *  land exactly where they were dropped. */
  async function handleAddMediaFiles(filePaths: string[], atMs: number) {
    const items = await buildMediaItems(filePaths);
    if (items.length === 0) return; // nothing playable in the drop
    addMediaItemsAt(items, atMs);
  }

  /** The Media panel card's own "add" button — the keyboard/click route to the same thing
   *  dragging a card onto a track does, landing the piece at the playhead. */
  function placeMediaAtPlayhead(item: EditProjectMediaItem) {
    if (item.durationMs <= 0) return;
    const clip = newMediaClip(item, previewMs.currentMs);
    handleTimelineChange(
      item.kind === "video"
        ? { ...timeline, videoClips: [...timeline.videoClips, clip] }
        : { ...timeline, audioClips: [...timeline.audioClips, clip] }
    );
  }

  /** Detaching a file takes its placed pieces with it — leaving them behind as unplayable
   *  "missing file" blocks would be worse than just removing what the user asked to remove.
   *  (The Timeline still renders that state: it's the safety net for a file that goes away
   *  on disk, or a save written before its item existed.) */
  function removeMediaItem(item: EditProjectMediaItem) {
    persistMediaItems(mediaItems.filter((m) => m.id !== item.id));
    const videoClips = timeline.videoClips.filter((c) => c.mediaId !== item.id);
    const audioClips = timeline.audioClips.filter((c) => c.mediaId !== item.id);
    if (videoClips.length !== timeline.videoClips.length || audioClips.length !== timeline.audioClips.length) {
      handleTimelineChange({ ...timeline, videoClips, audioClips });
    }
  }

  // Master/Cut chip-rail selection, one per tab — MASTER_CUT_ID means "editing the tab's
  // own master settings" (the usual `camera`/`cursor`/etc. state above); any other value
  // is a real TimelineClip/TimelineSegment id whose override is being edited instead (see
  // the cuts/activeXCut/onActiveXCutChange wiring right before the render below). Zoom has
  // no master concept (see EffectsEditPanel) so its own selection is nullable instead.
  const [activeScreenCut, setActiveScreenCut] = useState(MASTER_CUT_ID);
  const [activeCursorCut, setActiveCursorCut] = useState(MASTER_CUT_ID);
  const [activeCameraCut, setActiveCameraCut] = useState(MASTER_CUT_ID);
  const [activeLayoutCut, setActiveLayoutCut] = useState(MASTER_CUT_ID);
  const [activeExtVideoCut, setActiveExtVideoCut] = useState(MASTER_CUT_ID);
  const [activeExtSoundCut, setActiveExtSoundCut] = useState(MASTER_CUT_ID);
  const [activeZoomId, setActiveZoomId] = useState<string | null>(null);
  // The Effects tab's own selection — which callout/blur box the panel is editing and the
  // preview draws grab handles on. Null is a real state here (nothing selected), unlike the
  // chip rails above where "nothing specific" means the master settings.
  const [activeEffectId, setActiveEffectId] = useState<string | null>(null);
  // Which of the Effects tab's three blocks (Zoom/Callout/Blur) the nav/content pane shows —
  // owned here rather than inside EffectsEditPanel so a Timeline click (which already knows
  // exactly which kind it hit) can set this in the very same state update as the selection
  // itself. See EffectsEditPanelProps.navKind's own doc comment for why: the previous
  // effect-driven "follow the selection" inside the panel used to race a second effect that
  // auto-picked a default selection whenever the kind didn't match, which could leave the
  // chip rail and the Timeline's highlighted block disagreeing about what was selected.
  const [effectsNavKind, setEffectsNavKind] = useState<EffectsNavKind>("zoom");
  // Set whenever a chip-rail selection changes, so the Timeline highlights the matching
  // piece too (one-directional — see Timeline's own `focusRequest` prop doc comment).
  const [timelineFocusRequest, setTimelineFocusRequest] = useState<{ track: TrackKind; id: string } | null>(null);

  // A stray chip selection from the previous project must never carry over onto a newly
  // loaded one (its clip/segment/zoom ids mean nothing there).
  useEffect(() => {
    setActiveScreenCut(MASTER_CUT_ID);
    setActiveCursorCut(MASTER_CUT_ID);
    setActiveCameraCut(MASTER_CUT_ID);
    setActiveLayoutCut(MASTER_CUT_ID);
    setActiveExtVideoCut(MASTER_CUT_ID);
    setActiveExtSoundCut(MASTER_CUT_ID);
    setActiveZoomId(null);
    setActiveEffectId(null);
    setEffectsNavKind("zoom");
  }, [id]);

  // Undo/redo — a single history spanning every tab's settings and the Timeline (cuts,
  // zooms, camera hides), since from the user's perspective it's all "the edit," not five
  // separate ones. Rapid-fire changes to the same control (dragging a slider) are coalesced
  // into one history step rather than one per onChange tick, mirroring the save-debounce
  // pattern already used for each field above.
  const HISTORY_LIMIT = 100;
  const HISTORY_COALESCE_MS = 500;
  const pastRef = useRef<EditSnapshot[]>([]);
  const futureRef = useRef<EditSnapshot[]>([]);
  const historyBeforeRef = useRef<EditSnapshot | null>(null);
  const historyTimerRef = useRef<number | null>(null);
  // Guards applySnapshot's own calls to handleXChange from re-entering commitHistoryChange
  // — undo/redo must replay state without generating a new history entry for the replay.
  const isApplyingHistoryRef = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  function currentSnapshot(): EditSnapshot {
    return { camera, cursor, background, layout, timeline };
  }

  function commitHistoryChange() {
    if (isApplyingHistoryRef.current) return;
    // Only the first change of a burst captures "before" — later ones in the same burst
    // just push the coalescing window back out.
    if (historyBeforeRef.current === null) historyBeforeRef.current = currentSnapshot();
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
    historyTimerRef.current = window.setTimeout(() => {
      const before = historyBeforeRef.current;
      historyBeforeRef.current = null;
      if (!before) return;
      pastRef.current = [...pastRef.current, before].slice(-HISTORY_LIMIT);
      futureRef.current = [];
      setCanUndo(true);
      setCanRedo(false);
    }, HISTORY_COALESCE_MS);
  }

  function applySnapshot(snap: EditSnapshot) {
    isApplyingHistoryRef.current = true;
    handleCameraChange(snap.camera);
    handleCursorChange(snap.cursor);
    handleBackgroundChange(snap.background);
    handleLayoutChange(snap.layout);
    handleTimelineChange(snap.timeline);
    isApplyingHistoryRef.current = false;
  }

  function undo() {
    // A burst still waiting out its coalescing window counts as "the last change" —
    // flush it into `past` immediately so Ctrl+Z right after a drag undoes that drag.
    if (historyBeforeRef.current) {
      if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
      pastRef.current = [...pastRef.current, historyBeforeRef.current].slice(-HISTORY_LIMIT);
      historyBeforeRef.current = null;
    }
    if (pastRef.current.length === 0) return;
    const prev = pastRef.current[pastRef.current.length - 1];
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [...futureRef.current, currentSnapshot()];
    applySnapshot(prev);
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(true);
  }

  function redo() {
    if (futureRef.current.length === 0) return;
    const next = futureRef.current[futureRef.current.length - 1];
    futureRef.current = futureRef.current.slice(0, -1);
    pastRef.current = [...pastRef.current, currentSnapshot()];
    applySnapshot(next);
    setCanUndo(true);
    setCanRedo(futureRef.current.length > 0);
  }

  // Latest undo/redo in refs so the single global key listener below never needs to
  // re-subscribe — it always calls through to whichever closure is current.
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  undoRef.current = undo;
  redoRef.current = redo;

  // Resets when switching projects — a stray Ctrl+Z after navigating must never replay a
  // different project's history onto the one now loaded.
  useEffect(() => {
    pastRef.current = [];
    futureRef.current = [];
    historyBeforeRef.current = null;
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
    setCanUndo(false);
    setCanRedo(false);
  }, [id]);
  useEffect(() => {
    return () => {
      if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
    };
  }, []);

  // Global — undo/redo apply across every tab and the Timeline, not just whichever one
  // currently has focus, so this listens on window rather than a specific pane. Text
  // inputs (the title field) are excluded so the browser's own field-level undo still wins
  // there instead of being hijacked by the whole-edit history.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.key.toLowerCase() !== "z") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      e.preventDefault();
      if (e.shiftKey) redoRef.current();
      else undoRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Playhead/duration mirrored up from PreviewCompositor's own video element (it owns
  // playback) so the Timeline component below can render a synced ruler/playhead without
  // needing a second video element of its own.
  const [previewMs, setPreviewMs] = useState({
    currentMs: 0,
    durationMs: 0,
    sourceDurationMs: 0,
    alignedFootageLengthMs: 0,
  });
  const compositorRef = useRef<PreviewCompositorHandle>(null);
  const handlePreviewTimeUpdate = useCallback(
    (currentMs: number, durationMs: number, sourceDurationMs: number, alignedFootageLengthMs: number) => {
      setPreviewMs((prev) =>
        prev.currentMs === currentMs &&
        prev.durationMs === durationMs &&
        prev.sourceDurationMs === sourceDurationMs &&
        prev.alignedFootageLengthMs === alignedFootageLengthMs
          ? prev
          : { currentMs, durationMs, sourceDurationMs, alignedFootageLengthMs }
      );
    },
    []
  );
  const handleTimelineSeek = useCallback((ms: number) => {
    compositorRef.current?.seekMs(ms);
  }, []);

  // Default/Cut toggle rendered in the Timeline component — shared with PreviewCompositor
  // so selecting Cut there changes what clicking the preview canvas does.
  const [tool, setTool] = useState<TimelineTool>("default");

  // Shortcut keys for the tool toggle above — V for Default, C for Cut, the same
  // Selection/Razor convention most video editors (e.g. Premiere) use. Global like
  // undo/redo, with the same text-field exclusion so typing "v"/"c" in the title still
  // types "v"/"c" instead of swapping tools.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === "v") setTool("default");
      else if (key === "c") setTool("cut");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Space — play/pause the preview, the same global-with-text-field-exclusion pattern as
  // undo/redo and the tool shortcuts above. preventDefault unconditionally (not just when
  // a text field is excluded) so Space doesn't *also* click whatever button happens to have
  // focus — the play button itself included, which would otherwise double-toggle.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space" || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      e.preventDefault();
      compositorRef.current?.togglePlay();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Which project id the `project` query result has already been applied for, so a
  // background refetch (e.g. after rename) doesn't stomp on newer local edits.
  const loadedForIdRef = useRef<string | undefined>(undefined);
  // True only once the user actually edits the title field (set in the input's
  // onChange below) — NOT inferred from comparing state to a "last saved" value,
  // since load-time bookkeeping (setTitle from a fetched project, StrictMode's
  // double-invoked effects in dev, …) can transiently disagree with itself without
  // any real user edit, which previously caused a spurious rename-to-default right
  // after creating a project.
  const dirtyRef = useRef(false);
  const titleRef = useRef(title);
  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useEffect(() => {
    if (id && project && loadedForIdRef.current !== id) {
      setTitle(project.title);
      loadedForIdRef.current = id;
      dirtyRef.current = false;
      localStorage.setItem(LAST_PROJECT_KEY, id);
    }
  }, [id, project]);

  // Bare "/edit" entry point (top-nav Edit tab, or first launch) — resume whichever
  // project was last opened instead of starting a blank one; only fall back to a
  // blank, not-yet-created project if there's truly nothing to resume.
  useEffect(() => {
    if (id) return;
    const lastId = localStorage.getItem(LAST_PROJECT_KEY);
    if (lastId) {
      navigate(`/edit/${lastId}`, { replace: true });
      return;
    }
    if (loadedForIdRef.current !== undefined) {
      loadedForIdRef.current = undefined;
      setTitle(DEFAULT_TITLE);
      dirtyRef.current = false;
    }
  }, [id, navigate]);

  // An id in the URL that no longer resolves to a project (deleted from Library,
  // stale link, …) — fall back to a fresh, unsaved project rather than getting stuck.
  useEffect(() => {
    if (id && !projectLoading && project === null) {
      if (localStorage.getItem(LAST_PROJECT_KEY) === id) localStorage.removeItem(LAST_PROJECT_KEY);
      loadedForIdRef.current = undefined;
      setTitle(DEFAULT_TITLE);
      dirtyRef.current = false;
      navigate("/edit", { replace: true });
    }
  }, [id, project, projectLoading, navigate]);

  const saveTimerRef = useRef<number | null>(null);
  const savedFlashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!dirtyRef.current) return;
    // Existing project still loading — the debounce effect re-fires once loadedForIdRef
    // is set (title changes again on load), so it's safe to just wait rather than
    // risk creating a duplicate project for an id that already exists.
    if (id && !loadedForIdRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(async () => {
      const trimmed = titleRef.current.trim() || DEFAULT_TITLE;
      setSaveState("saving");
      try {
        if (!loadedForIdRef.current) {
          const created = await createProject.mutateAsync({ title: trimmed });
          loadedForIdRef.current = created.id;
          dirtyRef.current = false;
          localStorage.setItem(LAST_PROJECT_KEY, created.id);
          navigate(`/edit/${created.id}`, { replace: true });
        } else {
          await renameProject.mutateAsync({ id: loadedForIdRef.current, title: trimmed });
          dirtyRef.current = false;
        }
        setSaveState("saved");
        if (savedFlashTimerRef.current) window.clearTimeout(savedFlashTimerRef.current);
        savedFlashTimerRef.current = window.setTimeout(() => setSaveState("idle"), 1600);
      } catch {
        setSaveState("idle");
      }
    }, TITLE_SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
    // id is read for the "still loading" guard above but intentionally left out of the
    // deps below — createProject/renameProject/navigate too: none of them should reset
    // this timer on their own, only an actual title change should.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  // Best-effort flush so a quick "type a name then click away" isn't silently lost
  // just because the debounce above hadn't fired yet.
  useEffect(() => {
    return () => {
      if (!dirtyRef.current) return;
      const trimmed = titleRef.current.trim() || DEFAULT_TITLE;
      if (loadedForIdRef.current) renameProject.mutate({ id: loadedForIdRef.current, title: trimmed });
      else createProject.mutate({ title: trimmed });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (savedFlashTimerRef.current) window.clearTimeout(savedFlashTimerRef.current);
    };
  }, []);

  const [activeTab, setActiveTab] = useState<EditTab>(() => {
    const last = localStorage.getItem(LAST_TAB_KEY);
    return last && EDIT_TAB_IDS.includes(last) ? (last as EditTab) : "camera";
  });
  useEffect(() => {
    localStorage.setItem(LAST_TAB_KEY, activeTab);
  }, [activeTab]);
  const [topPct, setTopPct] = useState(() => readStoredPct(TOP_PCT_KEY, DEFAULT_TOP_PCT, MIN_TOP_PCT, MAX_TOP_PCT));
  const [leftPct, setLeftPct] = useState(() =>
    readStoredPct(LEFT_PCT_KEY, DEFAULT_LEFT_PCT, MIN_LEFT_PCT, MAX_LEFT_PCT)
  );

  const bodyRef = useRef<HTMLDivElement>(null);
  const topRowRef = useRef<HTMLDivElement>(null);
  const dragKindRef = useRef<"row" | "col" | null>(null);

  // Mirrors of the latest topPct/leftPct so the mouseup handler below (registered
  // once, never re-bound) can read current values without becoming stale.
  const topPctRef = useRef(topPct);
  const leftPctRef = useRef(leftPct);
  useEffect(() => {
    topPctRef.current = topPct;
  }, [topPct]);
  useEffect(() => {
    leftPctRef.current = leftPct;
  }, [leftPct]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const kind = dragKindRef.current;
      if (kind === "row" && bodyRef.current) {
        const rect = bodyRef.current.getBoundingClientRect();
        setTopPct(clamp(((e.clientY - rect.top) / rect.height) * 100, MIN_TOP_PCT, MAX_TOP_PCT));
      } else if (kind === "col" && topRowRef.current) {
        const rect = topRowRef.current.getBoundingClientRect();
        setLeftPct(clamp(((e.clientX - rect.left) / rect.width) * 100, MIN_LEFT_PCT, MAX_LEFT_PCT));
      }
    }
    function onUp() {
      if (!dragKindRef.current) return;
      const kind = dragKindRef.current;
      document.body.classList.remove("edit-resizing-row", "edit-resizing-col");
      dragKindRef.current = null;
      // Persist only the pane that was actually being dragged, read fresh from
      // state via the DOM-derived values already committed by the last onMove.
      if (kind === "row") localStorage.setItem(TOP_PCT_KEY, String(topPctRef.current));
      else localStorage.setItem(LEFT_PCT_KEY, String(leftPctRef.current));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Global resets — same per-tab handlers as each panel's own "Reset" button, just
  // fired across every tab at once. Only Camera has a real "as recorded" value; Cursor's
  // "original" drops the synthetic click effects but keeps style/size/color; the
  // remaining tabs have no record-time equivalent at all, so their "original" is their
  // default.
  // The Ext Video master rides along too (it's one of the tabs), but only that field of
  // `timeline` — a reset is about how things look, not about throwing away cuts, zooms or
  // placed pieces.
  function resetAllToDefault() {
    handleCameraChange(DEFAULT_CAMERA_EDIT_SETTINGS);
    handleCursorChange(DEFAULT_CURSOR_EDIT_SETTINGS);
    handleBackgroundChange(defaultBackgroundEditSettingsForPlatform());
    handleLayoutChange(DEFAULT_LAYOUT_EDIT_SETTINGS);
    handleTimelineChange({ ...timeline, extVideo: DEFAULT_EXT_VIDEO_EDIT_SETTINGS });
  }
  function resetAllToOriginal() {
    handleCameraChange(media?.recordedCamera ?? DEFAULT_CAMERA_EDIT_SETTINGS);
    handleCursorChange(ORIGINAL_CURSOR_EDIT_SETTINGS);
    handleBackgroundChange(defaultBackgroundEditSettingsForPlatform());
    handleLayoutChange(DEFAULT_LAYOUT_EDIT_SETTINGS);
    handleTimelineChange({ ...timeline, extVideo: DEFAULT_EXT_VIDEO_EDIT_SETTINGS });
  }

  const [exportOpen, setExportOpen] = useState(false);

  const [showMediaPaths, setShowMediaPaths] = useState(false);
  const mediaPathsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showMediaPaths) return;
    function onOutside(e: MouseEvent) {
      if (mediaPathsRef.current && !mediaPathsRef.current.contains(e.target as Node)) setShowMediaPaths(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [showMediaPaths]);

  const hasMedia = !mediaReleased && !!(media?.screenFilePath || media?.singleFilePath);

  const mediaFiles = [
    { label: "Screen", path: media?.screenFilePath },
    { label: "Camera", path: media?.cameraFilePath },
    { label: "Combined", path: media?.singleFilePath },
  ]
    .filter((f): f is { label: string; path: string } => !!f.path)
    .map((f) => ({ ...f, kind: AUDIO_PATH_RE.test(f.path) ? ("audio" as const) : ("video" as const) }));

  const startDrag = useCallback((kind: "row" | "col") => (e: React.MouseEvent) => {
    e.preventDefault();
    dragKindRef.current = kind;
    document.body.classList.add(kind === "row" ? "edit-resizing-row" : "edit-resizing-col");
  }, []);

  const resetRow = useCallback(() => {
    setTopPct(DEFAULT_TOP_PCT);
    localStorage.setItem(TOP_PCT_KEY, String(DEFAULT_TOP_PCT));
  }, []);
  const resetCol = useCallback(() => {
    setLeftPct(DEFAULT_LEFT_PCT);
    localStorage.setItem(LEFT_PCT_KEY, String(DEFAULT_LEFT_PCT));
  }, []);

  // Bundles everything a panel needs to work against either its tab's master settings or
  // one specific cut's override, given the chip-rail selection for that tab — shared by
  // the Screen/Camera tabs (footage pieces, override kept in a side map keyed by clip id)
  // and by clipCutRouting/segmentCutRouting below. `activeId` is re-validated against the
  // live `cuts` list every render (falling back to master) so a stale selection — e.g. the
  // active cut got deleted elsewhere — self-heals instead of pointing at nothing.
  interface CutRouting<T> {
    cuts: CutChipRailCut[];
    activeCutId: string;
    value: T;
    onChange: (next: T) => void;
    onActiveCutChange: (id: string) => void;
    onClearOverride: () => void;
  }
  function clipCutRouting<T>(
    track: TrackKind,
    clips: TimelineClip[],
    overrides: Record<string, T>,
    activeId: string,
    setActiveId: (id: string) => void,
    master: T,
    onMasterChange: (next: T) => void,
    writeOverrides: (next: Record<string, T>) => void
  ): CutRouting<T> {
    const cuts = clipCuts(clips, overrides);
    const safeId = cuts.some((c) => c.id === activeId) ? activeId : MASTER_CUT_ID;
    return {
      cuts,
      activeCutId: safeId,
      value: safeId === MASTER_CUT_ID ? master : (overrides[safeId] ?? master),
      onChange: (next) => {
        if (safeId === MASTER_CUT_ID) onMasterChange(next);
        else writeOverrides({ ...overrides, [safeId]: next });
      },
      onActiveCutChange: (cutId) => {
        setActiveId(cutId);
        if (cutId === MASTER_CUT_ID) return;
        setTimelineFocusRequest({ track, id: cutId });
        const clip = clips.find((c) => c.id === cutId);
        if (clip) handleTimelineSeek(clip.timelineStart);
      },
      onClearOverride: () => {
        if (safeId === MASTER_CUT_ID) return;
        const next = { ...overrides };
        delete next[safeId];
        writeOverrides(next);
      },
    };
  }
  function segmentCutRouting<T>(
    track: TrackKind,
    segments: TimelineSegment<T>[],
    activeId: string,
    setActiveId: (id: string) => void,
    master: T,
    onMasterChange: (next: T) => void,
    writeSegments: (next: TimelineSegment<T>[]) => void
  ): CutRouting<T> {
    const cuts = segmentCuts(segments);
    const safeId = cuts.some((c) => c.id === activeId) ? activeId : MASTER_CUT_ID;
    const seg = segments.find((s) => s.id === safeId);
    return {
      cuts,
      activeCutId: safeId,
      value: safeId === MASTER_CUT_ID ? master : (seg?.settings ?? master),
      onChange: (next) => {
        if (safeId === MASTER_CUT_ID) onMasterChange(next);
        else writeSegments(setSegmentSettings(segments, safeId, next));
      },
      onActiveCutChange: (cutId) => {
        setActiveId(cutId);
        if (cutId === MASTER_CUT_ID) return;
        setTimelineFocusRequest({ track, id: cutId });
        const s = segments.find((x) => x.id === cutId);
        if (s) handleTimelineSeek(s.startMs);
      },
      onClearOverride: () => {
        if (safeId === MASTER_CUT_ID) return;
        writeSegments(setSegmentSettings(segments, safeId, null));
      },
    };
  }

  const screenRouting = clipCutRouting(
    "clips", timeline.clips, timeline.clipOverrides, activeScreenCut, setActiveScreenCut,
    background, handleBackgroundChange, (next) => handleTimelineChange({ ...timeline, clipOverrides: next })
  );
  const cameraRouting = clipCutRouting(
    "camera", timeline.cameraClips, timeline.cameraClipOverrides, activeCameraCut, setActiveCameraCut,
    camera, handleCameraChange, (next) => handleTimelineChange({ ...timeline, cameraClipOverrides: next })
  );
  // The Ext Video track's own master/override pair lives inside `timeline` rather than on
  // the project (see TimelineEditSettings.extVideo), so both halves of this routing write
  // through the one handleTimelineChange.
  const extVideoRouting = clipCutRouting<ExtVideoEditSettings>(
    "video", timeline.videoClips, timeline.videoClipOverrides ?? {}, activeExtVideoCut, setActiveExtVideoCut,
    timeline.extVideo ?? DEFAULT_EXT_VIDEO_EDIT_SETTINGS,
    (next) => handleTimelineChange({ ...timeline, extVideo: next }),
    (next) => handleTimelineChange({ ...timeline, videoClipOverrides: next })
  );
  const cursorRouting = segmentCutRouting(
    "cursor", timeline.cursorSegments, activeCursorCut, setActiveCursorCut,
    cursor, handleCursorChange, (next) => handleTimelineChange({ ...timeline, cursorSegments: next })
  );
  const layoutRouting = segmentCutRouting(
    "layout", timeline.layoutSegments, activeLayoutCut, setActiveLayoutCut,
    layout, handleLayoutChange, (next) => handleTimelineChange({ ...timeline, layoutSegments: next })
  );

  // The two Ext tabs are hidden entirely until their track exists — a project with no
  // added media has nothing for either to edit, and an empty tab is just noise next to
  // the five that always apply. "Exists" is the same test the Timeline uses to decide
  // whether to draw the row at all (see its hasTrack): a file of that kind in the
  // project's pool, or a piece already placed on the track — so the tab appears the
  // moment the file is added, not only once something has been dragged onto the track,
  // and the panel is there to configure before the first piece lands.
  const hasExtVideo = mediaItems.some((m) => m.kind === "video") || timeline.videoClips.length > 0;
  const hasExtSound = mediaItems.some((m) => m.kind === "audio") || timeline.audioClips.length > 0;
  const visibleTabs = TABS.filter((t) =>
    t.id === "extVideo" ? hasExtVideo : t.id === "extSound" ? hasExtSound : true
  );
  // `activeTab` can name a tab that has since disappeared (its last file was detached,
  // or a project without added media loaded while an Ext tab was open) — resolved here
  // rather than corrected in an effect, so there's never a frame rendering a tab that
  // isn't in the rail. The stored preference is deliberately left alone: re-adding the
  // file brings the user straight back to the tab they were on.
  const shownTab: EditTab = visibleTabs.some((t) => t.id === activeTab) ? activeTab : "background";

  // Gates the preview's effect selection chrome: a box's grab handles competing with the
  // screen/camera boxes on every other tab would just be in the way.
  const effectsTabOpen = shownTab === "effects";

  // Ext Sound has no settings of its own yet (see ExtSoundEditPanel), so its rail needs
  // the cut list and the seek/focus behaviour but none of clipCutRouting's value/override
  // machinery - hence the hand-rolled pair rather than a routing with nothing to route.
  const extSoundCuts = clipCuts(timeline.audioClips, {});
  const safeExtSoundCut = extSoundCuts.some((c) => c.id === activeExtSoundCut) ? activeExtSoundCut : MASTER_CUT_ID;
  function selectExtSoundCut(cutId: string) {
    setActiveExtSoundCut(cutId);
    if (cutId === MASTER_CUT_ID) return;
    setTimelineFocusRequest({ track: "audio", id: cutId });
    const clip = timeline.audioClips.find((c) => c.id === cutId);
    if (clip) handleTimelineSeek(clip.timelineStart);
  }

  const safeActiveZoomId = activeZoomId && timeline.zooms.some((z) => z.id === activeZoomId) ? activeZoomId : null;
  /** Selecting a zoom also highlights its block on the Timeline and parks the playhead at
   *  its start, so what the preview shows is actually the zoom being edited — same as
   *  selectEffect below. `known` covers selecting a zoom that was only just added, before
   *  `timeline` re-renders (see handleZoomAdd). Also switches the Effects tab's own nav to
   *  Zoom and clears any callout/blur selection, since only one of the three is ever "the"
   *  selection at a time. */
  function selectZoom(zoomId: string, known?: TimelineZoom) {
    setActiveZoomId(zoomId);
    setActiveEffectId(null);
    setEffectsNavKind("zoom");
    const z = known ?? timeline.zooms.find((zm) => zm.id === zoomId);
    if (!z) return;
    setTimelineFocusRequest({ track: "zoom", id: z.id });
    handleTimelineSeek(z.startMs);
  }
  /** Drops a new zoom on the Timeline's Zoom row, its window starting a beat before the
   *  playhead (see ZOOM_LEAD_MS) — same "add at the playhead" convention handleEffectAdd
   *  uses for Callout/Blur below, now that Zoom shares the same Effects-tab Add button. */
  function handleZoomAdd() {
    const anchorMs = Math.max(0, previewMs.currentMs);
    const startMs = Math.max(0, anchorMs - ZOOM_LEAD_MS);
    const durationMs = Math.min(ZOOM_DEFAULT_DURATION_MS, Math.max(200, previewMs.durationMs - startMs));
    const zoom: TimelineZoom = {
      id: crypto.randomUUID(),
      startMs,
      durationMs,
      pct: ZOOM_DEFAULT_PCT,
      style: DEFAULT_NEW_ZOOM_STYLE,
      tilt: { ...DEFAULT_NEW_ZOOM_TILT },
    };
    handleTimelineChange({ ...timeline, zooms: [...timeline.zooms, zoom] });
    selectZoom(zoom.id, zoom);
  }
  function handleZoomSetPct(zoomId: string, pct: number) {
    handleTimelineChange({ ...timeline, zooms: setZoomPctLib(timeline.zooms, zoomId, pct) });
  }
  function handleZoomSetStyle(zoomId: string, style: TimelineZoomStyle) {
    handleTimelineChange({ ...timeline, zooms: setZoomStyleLib(timeline.zooms, zoomId, style) });
  }
  function handleZoomSetTilt(zoomId: string, patch: Partial<TimelineZoomTilt>) {
    handleTimelineChange({ ...timeline, zooms: setZoomTiltLib(timeline.zooms, zoomId, patch) });
  }
  function handleZoomRemove(zoomId: string) {
    handleTimelineChange({ ...timeline, zooms: removeZoomLib(timeline.zooms, zoomId) });
    if (activeZoomId === zoomId) setActiveZoomId(null);
  }

  // Effects tab — callout/blur boxes. Same shape as the zoom handlers above: every edit
  // goes through handleTimelineChange, so preview drags, quick picks and panel sliders all
  // land in one undo history and one save debounce.
  const safeActiveEffectId =
    activeEffectId && (timeline.effects ?? []).some((e) => e.id === activeEffectId) ? activeEffectId : null;
  /** Drops a new box on its kind's Timeline row, its window starting at the playhead —
   *  where the user is already looking — and running the default length, or to the end of
   *  the timeline if that's nearer. Moving/trimming it afterwards is the Timeline's job. */
  function handleEffectAdd(kind: TimelineEffectKind, box?: TimelineEffectBox) {
    const startMs = Math.max(0, previewMs.currentMs);
    const durationMs = Math.max(
      MIN_EFFECT_MS,
      Math.min(EFFECT_DEFAULT_DURATION_MS, Math.max(MIN_EFFECT_MS, previewMs.durationMs - startMs))
    );
    const effect = createEffect(kind, box, startMs, durationMs);
    handleTimelineChange({ ...timeline, effects: addEffectLib(timeline.effects ?? [], effect) });
    selectEffect(effect.id, effect);
  }
  /** Selecting a box also highlights its block on the Timeline and parks the playhead at its
   *  start, so what the preview shows is actually the box being edited — same as selectZoom.
   *  `known` covers selecting a box that was only just added, before `timeline` re-renders.
   *  Also switches the Effects tab's own nav to this box's kind and clears any zoom
   *  selection, since only one of the three is ever "the" selection at a time. */
  function selectEffect(effectId: string, known?: TimelineEffect) {
    setActiveEffectId(effectId);
    setActiveZoomId(null);
    const fx = known ?? (timeline.effects ?? []).find((e) => e.id === effectId);
    if (!fx) return;
    setEffectsNavKind(fx.kind);
    setTimelineFocusRequest({ track: fx.kind, id: fx.id });
    handleTimelineSeek(fx.startMs);
  }
  function handleEffectPatch(effectId: string, patch: Partial<TimelineEffect>) {
    handleTimelineChange({ ...timeline, effects: updateEffectLib(timeline.effects ?? [], effectId, patch) });
  }
  function handleEffectRemove(effectId: string) {
    handleTimelineChange({ ...timeline, effects: removeEffectLib(timeline.effects ?? [], effectId) });
    if (activeEffectId === effectId) setActiveEffectId(null);
  }

  /** Switching the Effects tab's nav (Zoom/Callout/Blur) auto-selects the first existing
   *  block of that kind, so the pane opens straight on its settings instead of sitting
   *  empty until a chip is clicked — but only when nothing of that kind is already selected;
   *  a kind with nothing at all stays on the empty state until Add is clicked. This is a
   *  deliberate one-shot action tied to the nav button's own click, not a reactive effect —
   *  see EffectsEditPanelProps.navKind's doc comment for why that distinction matters. */
  function handleEffectsNavKindChange(kind: EffectsNavKind) {
    setEffectsNavKind(kind);
    if (kind === "zoom") {
      setActiveEffectId(null);
      if (!activeZoomId || !timeline.zooms.some((z) => z.id === activeZoomId)) {
        setActiveZoomId(timeline.zooms[0]?.id ?? null);
      }
    } else {
      setActiveZoomId(null);
      const current = (timeline.effects ?? []).find((e) => e.id === activeEffectId);
      if (!current || current.kind !== kind) {
        setActiveEffectId((timeline.effects ?? []).find((e) => e.kind === kind)?.id ?? null);
      }
    }
  }

  // The reverse of each xRouting.onActiveCutChange above — clicking (or marquee-selecting
  // down to) one piece directly in the Timeline switches to that track's own tab and
  // selects the matching cut/zoom there, so its settings show in the panel immediately.
  // Doesn't touch `timelineFocusRequest` — the Timeline's own selection already reflects
  // this piece, nothing needs to be pushed back onto it. Callout/Blur/Zoom set
  // `effectsNavKind` directly (rather than going through selectEffect/selectZoom, which also
  // seek the playhead — a direct Timeline click shouldn't jump playback away from where the
  // user clicked within the block).
  function handleTimelineSoleSelect(track: TrackKind, id: string) {
    switch (track) {
      case "clips":
        setActiveTab("background");
        setActiveScreenCut(id);
        break;
      case "camera":
        setActiveTab("camera");
        setActiveCameraCut(id);
        break;
      case "cursor":
        setActiveTab("cursor");
        setActiveCursorCut(id);
        break;
      case "layout":
        setActiveTab("layout");
        setActiveLayoutCut(id);
        break;
      case "callout":
      case "blur":
        setActiveTab("effects");
        setActiveEffectId(id);
        setActiveZoomId(null);
        setEffectsNavKind(track);
        break;
      case "zoom":
        setActiveTab("effects");
        setActiveZoomId(id);
        setActiveEffectId(null);
        setEffectsNavKind("zoom");
        break;
      case "video":
        setActiveTab("extVideo");
        setActiveExtVideoCut(id);
        break;
      case "audio":
        setActiveTab("extSound");
        setActiveExtSoundCut(id);
        break;
    }
  }

  return (
    <section className="panel edit-page">
      <div className="edit-topbar">
        <div className="edit-title-group">
          <input
            className="edit-title-input"
            value={title}
            onChange={(e) => {
              dirtyRef.current = true;
              setTitle(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder={DEFAULT_TITLE}
          />
          {saveState === "saving" && (
            <span className="edit-title-status">
              <Loader2 size={13} className="edit-title-status-spin" />
              Saving…
            </span>
          )}
          {saveState === "saved" && (
            <span className="edit-title-status edit-title-status-saved">
              <Check size={13} />
              Saved
            </span>
          )}
        </div>
        <div className="edit-topbar-actions">
          <div className="edit-media-info" ref={mediaPathsRef}>
            <button
              type="button"
              className="edit-topbar-btn"
              aria-pressed={showMediaPaths}
              onClick={() => setShowMediaPaths((v) => !v)}
            >
              <FolderOpen size={15} />
              Media
            </button>
            {showMediaPaths && (
              <div className="edit-media-info-panel">
                {/* One row of equal boxes: the recording's own files, then whatever's been
                    added to the project, then the "Add media" box itself, always last. The
                    panel is anchored to the button's right edge and sized to its content, so
                    each box added grows the row leftward rather than pushing anything
                    offscreen. Each added box is an HTML5 drag source carrying its own item id
                    under a track-specific MIME type, which is what lets the matching Timeline
                    track light up (and the other one refuse it) from `dataTransfer.types`
                    alone during the dragover, before any payload is readable. */}
                <div className="edit-media-file-grid">
                  {mediaFiles.map((f) => {
                    const Icon = f.kind === "audio" ? FileAudio : FileVideo;
                    return (
                      <div className={`edit-media-info-row edit-media-info-row-${f.kind}`} key={f.label}>
                        <Icon size={22} className={`edit-media-info-icon edit-media-info-icon-${f.kind}`} />
                        <div className="edit-media-info-text">
                          <span className="edit-media-info-label">{f.label}</span>
                          <span className="edit-media-info-path" title={f.path}>{f.path}</span>
                        </div>
                      </div>
                    );
                  })}

                  {mediaItems.map((item) => {
                    const Icon = item.kind === "audio" ? FileAudio : FileVideo;
                    const unreadable = item.durationMs <= 0;
                    return (
                      <div
                        key={item.id}
                        className={`edit-media-info-row edit-media-added-row edit-media-info-row-${item.kind}${unreadable ? " edit-media-added-row-bad" : ""}`}
                        draggable={!unreadable}
                        onDragStart={(e) => {
                          e.dataTransfer.setData(MEDIA_DRAG_MIME_PREFIX + item.kind, item.id);
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        title={
                          unreadable
                            ? `${item.filePath} — this file couldn't be read, so there's nothing to place`
                            : `${item.filePath} — drag onto the ${item.kind === "video" ? "Ext Video" : "Ext Audio"} track in the timeline, or use + to drop it at the playhead`
                        }
                      >
                        {/* Both affordances live in the box's own corners so it keeps the
                            exact shape of the recording's boxes next to it. */}
                        <button
                          type="button"
                          className="edit-media-corner-btn edit-media-corner-add"
                          onClick={() => placeMediaAtPlayhead(item)}
                          disabled={unreadable}
                          title={`Add to the ${item.kind === "video" ? "Ext Video" : "Ext Audio"} track at the playhead`}
                        >
                          <Plus size={11} />
                        </button>
                        <button
                          type="button"
                          className="edit-media-corner-btn edit-media-corner-remove"
                          onClick={() => removeMediaItem(item)}
                          title="Remove from this project (also removes its pieces from the timeline)"
                        >
                          <X size={11} />
                        </button>
                        <Icon size={22} className={`edit-media-info-icon edit-media-info-icon-${item.kind}`} />
                        <div className="edit-media-info-text">
                          <span className="edit-media-info-label" title={item.name}>{item.name}</span>
                          <span className="edit-media-info-path">
                            {unreadable ? "unreadable" : formatMediaDuration(item.durationMs)}
                          </span>
                        </div>
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    className="edit-media-info-row edit-media-add-card"
                    onClick={handlePickMediaFiles}
                    disabled={addingMedia || !id}
                    title={
                      id
                        ? "Add audio or video files — pick several at once; each lands at the end of the timeline"
                        : "Give this project a name first — it's saved on its first edit"
                    }
                  >
                    {addingMedia ? (
                      <Loader2 size={22} className="edit-media-info-icon edit-media-add-icon edit-title-status-spin" />
                    ) : (
                      <Plus size={22} className="edit-media-info-icon edit-media-add-icon" />
                    )}
                    {/* A span, not the div the file boxes use — a <button>'s content model
                        is phrasing content only, and .edit-media-info-text's own display:flex
                        makes the two render identically. */}
                    <span className="edit-media-info-text">
                      <span className="edit-media-info-label">Add media</span>
                      <span className="edit-media-info-path">audio or video</span>
                    </span>
                  </button>
                </div>

               
              </div>
            )}
          </div>
          <button type="button" className="edit-topbar-btn primary" onClick={() => setExportOpen(true)} disabled={!hasMedia}>
            <Upload size={15} />
            Export
          </button>
        </div>
      </div>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        compositorRef={compositorRef}
        layoutFormat={layout.format}
        title={title}
      />

      <div className="edit-body" ref={bodyRef}>
        {!hasMedia ? (
          <div className="edit-empty-state">
            <FolderOpen size={32} className="edit-empty-state-icon" />
            <h2>No project to edit yet</h2>
            <p className="muted">Create a project in the Library's Projects section to start editing.</p>
            <button
              type="button"
              className="edit-topbar-btn primary"
              onClick={() => navigate("/library?section=projects")}
            >
              Go to Library
            </button>
          </div>
        ) : (
          <>
            <div className="edit-top-row" ref={topRowRef} style={{ flexBasis: `${topPct}%` }}>
              <div className="edit-sidebar" style={{ flexBasis: `${leftPct}%` }}>
                <div className="edit-tab-rail">
                  {visibleTabs.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <button
                        type="button"
                        key={tab.id}
                        className={`edit-tab-btn${shownTab === tab.id ? " active" : ""}`}
                        aria-pressed={shownTab === tab.id}
                        onClick={() => setActiveTab(tab.id)}
                      >
                        <Icon size={18} />
                        <span>{tab.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="edit-tab-panel">
                  {shownTab === "camera" ? (
                    <CameraEditPanel
                      media={media}
                      mediaLoading={mediaLoading}
                      camera={cameraRouting.value}
                      originalCamera={media?.recordedCamera ?? DEFAULT_CAMERA_EDIT_SETTINGS}
                      onChange={cameraRouting.onChange}
                      onResetAllToOriginal={resetAllToOriginal}
                      onResetAllToDefault={resetAllToDefault}
                      cuts={cameraRouting.cuts}
                      activeCutId={cameraRouting.activeCutId}
                      onActiveCutChange={cameraRouting.onActiveCutChange}
                      onClearOverride={cameraRouting.onClearOverride}
                    />
                  ) : shownTab === "cursor" ? (
                    <CursorEditPanel
                      cursor={cursorRouting.value}
                      onChange={cursorRouting.onChange}
                      onResetAllToOriginal={resetAllToOriginal}
                      onResetAllToDefault={resetAllToDefault}
                      cursorBakedIn={media!.cursorBakedIn}
                      cuts={cursorRouting.cuts}
                      activeCutId={cursorRouting.activeCutId}
                      onActiveCutChange={cursorRouting.onActiveCutChange}
                      onClearOverride={cursorRouting.onClearOverride}
                    />
                  ) : shownTab === "background" ? (
                    <BackgroundEditPanel
                      background={screenRouting.value}
                      defaultBackground={defaultBackgroundEditSettingsForPlatform()}
                      onChange={screenRouting.onChange}
                      screenSizePct={layout.freeScreenSizePct}
                      screenHeightPct={layout.freeScreenHeightPct}
                      onScreenSizeChange={(sizePct, heightPct) =>
                        handleLayoutChange({
                          ...layout,
                          freeScreenSizePct: sizePct,
                          freeScreenHeightPct: heightPct,
                          // Same as PreviewCompositor's own resize-drag handler: while
                          // freeScreenPos is still null, "split" layout auto-derives the
                          // screen box's size to fill whatever the camera isn't using,
                          // ignoring freeScreenSizePct/HeightPct entirely — so without
                          // this, the slider would silently do nothing until the user
                          // first dragged the box by hand. {50,50} is the same neutral
                          // centered value resolveDragPos already falls back to for a
                          // null position, so this is a no-op everywhere except that one
                          // split-still-untouched case.
                          freeScreenPos: layout.freeScreenPos ?? { xPct: 50, yPct: 50 },
                        })
                      }
                      onResetAllToOriginal={resetAllToOriginal}
                      onResetAllToDefault={resetAllToDefault}
                      cuts={screenRouting.cuts}
                      activeCutId={screenRouting.activeCutId}
                      onActiveCutChange={screenRouting.onActiveCutChange}
                      onClearOverride={screenRouting.onClearOverride}
                    />
                  ) : shownTab === "layout" ? (
                    <LayoutEditPanel
                      media={media}
                      mediaLoading={mediaLoading}
                      layout={layoutRouting.value}
                      onChange={layoutRouting.onChange}
                      onResetAllToOriginal={resetAllToOriginal}
                      onResetAllToDefault={resetAllToDefault}
                      cuts={layoutRouting.cuts}
                      activeCutId={layoutRouting.activeCutId}
                      onActiveCutChange={layoutRouting.onActiveCutChange}
                      onClearOverride={layoutRouting.onClearOverride}
                    />
                  ) : shownTab === "effects" ? (
                    <EffectsEditPanel
                      navKind={effectsNavKind}
                      onNavKindChange={handleEffectsNavKindChange}
                      effects={timeline.effects ?? []}
                      activeEffectId={safeActiveEffectId}
                      onActiveEffectChange={(effectId) => (effectId ? selectEffect(effectId) : setActiveEffectId(null))}
                      onAddEffect={handleEffectAdd}
                      onPatchEffect={handleEffectPatch}
                      onRemoveEffect={handleEffectRemove}
                      zooms={timeline.zooms}
                      activeZoomId={safeActiveZoomId}
                      onActiveZoomChange={(zoomId) => (zoomId ? selectZoom(zoomId) : setActiveZoomId(null))}
                      onAddZoom={handleZoomAdd}
                      onSetZoomPct={handleZoomSetPct}
                      onSetZoomStyle={handleZoomSetStyle}
                      onSetZoomTilt={handleZoomSetTilt}
                      onRemoveZoom={handleZoomRemove}
                    />
                  ) : shownTab === "extVideo" ? (
                    <ExtVideoEditPanel
                      extVideo={extVideoRouting.value}
                      onChange={extVideoRouting.onChange}
                      onResetAllToOriginal={resetAllToOriginal}
                      onResetAllToDefault={resetAllToDefault}
                      cuts={extVideoRouting.cuts}
                      activeCutId={extVideoRouting.activeCutId}
                      onActiveCutChange={extVideoRouting.onActiveCutChange}
                      onClearOverride={extVideoRouting.onClearOverride}
                      empty={timeline.videoClips.length === 0}
                    />
                  ) : (
                    <ExtSoundEditPanel
                      cuts={extSoundCuts}
                      activeCutId={safeExtSoundCut}
                      onActiveCutChange={selectExtSoundCut}
                      empty={timeline.audioClips.length === 0}
                    />
                  )}
                </div>
              </div>

              <div
                className="edit-handle edit-handle-col"
                onMouseDown={startDrag("col")}
                onDoubleClick={resetCol}
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize · double-click to reset"
              >
                <GripHorizontal size={12} className="edit-handle-grip edit-handle-grip-col" />
              </div>

              <div className="edit-preview">
                <PreviewCompositor
                  ref={compositorRef}
                  screenFilePath={(media!.screenFilePath ?? media!.singleFilePath)!}
                  cameraFilePath={media!.cameraFilePath ?? undefined}
                  audioFilePath={media!.audioFilePath ?? undefined}
                  sideClipStartOffsetMs={media!.sideClipStartOffsetMs}
                  cursorMetadataPath={media!.cursorMetadataPath}
                  cursorIconsDir={media!.cursorIconsDir}
                  cursorBakedIn={media!.cursorBakedIn}
                  mediaItems={mediaItems}
                  camera={camera}
                  onCameraChange={handleCameraChange}
                  background={background}
                  cursor={cursor}
                  layout={layout}
                  onLayoutChange={handleLayoutChange}
                  timeline={timeline}
                  onTimelineChange={handleTimelineChange}
                  activeEffectId={effectsTabOpen ? safeActiveEffectId : null}
                  onActiveEffectChange={setActiveEffectId}
                  tool={tool}
                  onTimeUpdate={handlePreviewTimeUpdate}
                  onUndo={undo}
                  onRedo={redo}
                  canUndo={canUndo}
                  canRedo={canRedo}
                />
              </div>
            </div>

            <div
              className="edit-handle edit-handle-row"
              onMouseDown={startDrag("row")}
              onDoubleClick={resetRow}
              role="separator"
              aria-orientation="horizontal"
              title="Drag to resize · double-click to reset"
            >
              <GripHorizontal size={14} className="edit-handle-grip" />
            </div>

            <div className="edit-timeline">
              <Timeline
                timeline={timeline}
                onChange={handleTimelineChange}
                currentMs={previewMs.currentMs}
                durationMs={previewMs.durationMs}
                sourceDurationMs={previewMs.sourceDurationMs}
                onSeek={handleTimelineSeek}
                tool={tool}
                onToolChange={setTool}
                cameraHidden={camera.hidden}
                hasCamera={!!media!.cameraFilePath}
                cameraStartOffsetMs={media!.sideClipStartOffsetMs}
                alignedFootageLengthMs={previewMs.alignedFootageLengthMs}
                cursorMetadataPath={media!.cursorMetadataPath}
                autoZoomOnLoad={project ? project.timeline === undefined : false}
                focusRequest={timelineFocusRequest}
                onFocusConsumed={() => setTimelineFocusRequest(null)}
                activeTrack={effectsTabOpen ? effectsNavKind : TAB_TRACK[shownTab]}
                onSoleSelect={handleTimelineSoleSelect}
                mediaItems={mediaItems}
                onAddMediaFiles={handleAddMediaFiles}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
