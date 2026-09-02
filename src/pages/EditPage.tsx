import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Camera,
  MousePointer2,
  ImageIcon,
  LayoutTemplate,
  Volume2,
  FolderOpen,
  Upload,
  Check,
  Loader2,
  GripHorizontal,
  FileVideo,
  FileAudio,
  type LucideIcon,
} from "lucide-react";
import { CameraEditPanel } from "../components/CameraEditPanel";
import { CursorEditPanel } from "../components/CursorEditPanel";
import { BackgroundEditPanel } from "../components/BackgroundEditPanel";
import { SoundEditPanel } from "../components/SoundEditPanel";
import { LayoutEditPanel } from "../components/LayoutEditPanel";
import { PreviewCompositor, type PreviewCompositorHandle } from "../components/PreviewCompositor";
import { ExportDialog } from "../components/ExportDialog";
import { Timeline, type TimelineTool } from "../components/Timeline";
import {
  useCreateEditProject,
  useEditProject,
  useEditProjectMedia,
  useRenameEditProject,
  useUpdateEditProjectBackground,
  useUpdateEditProjectCamera,
  useUpdateEditProjectCursor,
  useUpdateEditProjectSound,
  useUpdateEditProjectLayout,
  useUpdateEditProjectTimeline,
} from "../hooks/useEditProjects";
import {
  DEFAULT_BACKGROUND_EDIT_SETTINGS,
  DEFAULT_CAMERA_EDIT_SETTINGS,
  DEFAULT_CURSOR_EDIT_SETTINGS,
  ORIGINAL_CURSOR_EDIT_SETTINGS,
  DEFAULT_SOUND_EDIT_SETTINGS,
  DEFAULT_LAYOUT_EDIT_SETTINGS,
  DEFAULT_TIMELINE_EDIT_SETTINGS,
  type BackgroundEditSettings,
  type CameraEditSettings,
  type CursorEditSettings,
  type SoundEditSettings,
  type LayoutEditSettings,
  type TimelineEditSettings,
} from "@shared/types/models";
import "./EditPage.css";

type EditTab = "camera" | "cursor" | "background" | "layout" | "sound";

interface EditSnapshot {
  camera: CameraEditSettings;
  cursor: CursorEditSettings;
  background: BackgroundEditSettings;
  sound: SoundEditSettings;
  layout: LayoutEditSettings;
  timeline: TimelineEditSettings;
}

const TABS: { id: EditTab; label: string; icon: LucideIcon }[] = [
  { id: "background", label: "Screen", icon: ImageIcon },
  { id: "cursor", label: "Cursor", icon: MousePointer2 },
  { id: "camera", label: "Camera", icon: Camera },
  { id: "layout", label: "Layout", icon: LayoutTemplate },
  { id: "sound", label: "Sound", icon: Volume2 },
];
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
  const updateSound = useUpdateEditProjectSound();
  const updateLayout = useUpdateEditProjectLayout();
  const updateTimeline = useUpdateEditProjectTimeline();

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
      setCursor(project.cursor ?? DEFAULT_CURSOR_EDIT_SETTINGS);
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

  const [background, setBackground] = useState<BackgroundEditSettings>(DEFAULT_BACKGROUND_EDIT_SETTINGS);
  const backgroundLoadedForIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (id && project && backgroundLoadedForIdRef.current !== id) {
      // Merged with defaults, not just falling back to them wholesale — projects saved
      // before newer fields (e.g. crop) existed still have a `background` object, just
      // missing those keys.
      setBackground({ ...DEFAULT_BACKGROUND_EDIT_SETTINGS, ...(project.background ?? {}) });
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

  const [sound, setSound] = useState<SoundEditSettings>(DEFAULT_SOUND_EDIT_SETTINGS);
  const soundLoadedForIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (id && project && soundLoadedForIdRef.current !== id) {
      setSound(project.sound ?? DEFAULT_SOUND_EDIT_SETTINGS);
      soundLoadedForIdRef.current = id;
    }
  }, [id, project]);

  const soundSaveTimerRef = useRef<number | null>(null);
  const soundPendingRef = useRef<SoundEditSettings | null>(null);
  function handleSoundChange(next: SoundEditSettings) {
    commitHistoryChange();
    setSound(next);
    if (!id) return;
    soundPendingRef.current = next;
    if (soundSaveTimerRef.current) window.clearTimeout(soundSaveTimerRef.current);
    soundSaveTimerRef.current = window.setTimeout(() => {
      soundPendingRef.current = null;
      updateSound.mutate({ id, sound: next });
    }, 500);
  }
  useEffect(() => {
    return () => {
      if (soundSaveTimerRef.current) window.clearTimeout(soundSaveTimerRef.current);
      if (soundPendingRef.current && loadedForIdRef.current) {
        updateSound.mutate({ id: loadedForIdRef.current, sound: soundPendingRef.current });
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
      setTimeline({ ...DEFAULT_TIMELINE_EDIT_SETTINGS, ...(project.timeline ?? {}) });
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
    return { camera, cursor, background, sound, layout, timeline };
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
    handleSoundChange(snap.sound);
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
  const [previewMs, setPreviewMs] = useState({ currentMs: 0, durationMs: 0, sourceDurationMs: 0 });
  const compositorRef = useRef<PreviewCompositorHandle>(null);
  const handlePreviewTimeUpdate = useCallback((currentMs: number, durationMs: number, sourceDurationMs: number) => {
    setPreviewMs((prev) =>
      prev.currentMs === currentMs && prev.durationMs === durationMs && prev.sourceDurationMs === sourceDurationMs
        ? prev
        : { currentMs, durationMs, sourceDurationMs }
    );
  }, []);
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
  function resetAllToDefault() {
    handleCameraChange(DEFAULT_CAMERA_EDIT_SETTINGS);
    handleCursorChange(DEFAULT_CURSOR_EDIT_SETTINGS);
    handleBackgroundChange(DEFAULT_BACKGROUND_EDIT_SETTINGS);
    handleSoundChange(DEFAULT_SOUND_EDIT_SETTINGS);
    handleLayoutChange(DEFAULT_LAYOUT_EDIT_SETTINGS);
  }
  function resetAllToOriginal() {
    handleCameraChange(media?.recordedCamera ?? DEFAULT_CAMERA_EDIT_SETTINGS);
    handleCursorChange(ORIGINAL_CURSOR_EDIT_SETTINGS);
    handleBackgroundChange(DEFAULT_BACKGROUND_EDIT_SETTINGS);
    handleSoundChange(DEFAULT_SOUND_EDIT_SETTINGS);
    handleLayoutChange(DEFAULT_LAYOUT_EDIT_SETTINGS);
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
                {mediaFiles.length === 0 ? (
                  <div className="edit-media-info-empty">No media files yet.</div>
                ) : (
                  mediaFiles.map((f) => {
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
                  })
                )}
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
                  {TABS.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <button
                        type="button"
                        key={tab.id}
                        className={`edit-tab-btn${activeTab === tab.id ? " active" : ""}`}
                        aria-pressed={activeTab === tab.id}
                        onClick={() => setActiveTab(tab.id)}
                      >
                        <Icon size={18} />
                        <span>{tab.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="edit-tab-panel">
                  {activeTab === "camera" ? (
                    <CameraEditPanel
                      media={media}
                      mediaLoading={mediaLoading}
                      camera={camera}
                      originalCamera={media?.recordedCamera ?? DEFAULT_CAMERA_EDIT_SETTINGS}
                      onChange={handleCameraChange}
                      onResetAllToOriginal={resetAllToOriginal}
                      onResetAllToDefault={resetAllToDefault}
                    />
                  ) : activeTab === "cursor" ? (
                    <CursorEditPanel
                      cursor={cursor}
                      onChange={handleCursorChange}
                      onResetAllToOriginal={resetAllToOriginal}
                      onResetAllToDefault={resetAllToDefault}
                      cursorBakedIn={media!.cursorBakedIn}
                    />
                  ) : activeTab === "background" ? (
                    <BackgroundEditPanel
                      background={background}
                      onChange={handleBackgroundChange}
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
                    />
                  ) : activeTab === "layout" ? (
                    <LayoutEditPanel
                      media={media}
                      mediaLoading={mediaLoading}
                      layout={layout}
                      onChange={handleLayoutChange}
                      onResetAllToOriginal={resetAllToOriginal}
                      onResetAllToDefault={resetAllToDefault}
                    />
                  ) : (
                    <SoundEditPanel
                      sound={sound}
                      onChange={handleSoundChange}
                      onResetAllToOriginal={resetAllToOriginal}
                      onResetAllToDefault={resetAllToDefault}
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
                  camera={camera}
                  onCameraChange={handleCameraChange}
                  background={background}
                  cursor={cursor}
                  layout={layout}
                  onLayoutChange={handleLayoutChange}
                  sound={sound}
                  onSoundChange={handleSoundChange}
                  timeline={timeline}
                  onTimelineChange={handleTimelineChange}
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
                cursorMetadataPath={media!.cursorMetadataPath}
                autoZoomOnLoad={project ? project.timeline === undefined : false}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
