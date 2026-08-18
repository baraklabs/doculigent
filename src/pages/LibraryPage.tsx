import { useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Bot,
  Clapperboard,
  Mic,
  Users,
  Link2,
  FileText,
  Check,
  X,
  FolderOpen,
  FolderKanban,
  SquarePlay,
  FileUp,
  Plus,
  Pencil,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import type { EditProject, EditProjectSource, TranscriptSegment, Video } from "@shared/types/models";
import { mediaUrl } from "@shared/constants/media";
import { DEFAULT_TRANSCRIPTION_LANGUAGE, TRANSCRIPTION_LANGUAGES } from "@shared/constants/languages";
import { WHISPER_MODELS } from "@shared/constants/whisperModels";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";
import { isBilledTier } from "@shared/constants/plans";
import {
  useDeleteVideo,
  useDeleteVideos,
  useImportVideos,
  useRenameVideo,
  useSetVideoTranscript,
  useVideo,
  useVideos,
} from "../hooks/useVideos";
import { useCreateEditProject, useDeleteEditProject, useDeleteEditProjects, useEditProjects } from "../hooks/useEditProjects";
import { useLlmProfiles } from "../hooks/useLlmProfiles";
import { useAutoTranscribeSettings } from "../hooks/useAutoTranscribeSettings";
import { TranscriptionService } from "../services/transcription/TranscriptionService";
import { LibraryService } from "../services/library/LibraryService";
import { SettingsService } from "../services/settings/SettingsService";
import { TeamsSection } from "../components/TeamsSection";
import { StorageFileBrowser } from "../components/StorageFileBrowser";
import { ShareToStoragePanel } from "../components/ShareToStoragePanel";
import { useStoragePreference } from "../hooks/useStorage";
import { useAuthStore } from "../store/authStore";
import { useToast } from "../hooks/useToast";
import { friendlyErrorMessage } from "../utils/errors";
import "./LibraryPage.css";

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function showThumbnailFrame(e: SyntheticEvent<HTMLVideoElement>): void {
  const video = e.currentTarget;
  video.currentTime = Math.min(0.1, video.duration || 0);
}

const SECTIONS = [
  { id: "videos", label: "Videos", icon: <Clapperboard size={16} />, accent: "#5b4bf5", tint: "rgba(91, 75, 245, .09)" },
  { id: "meeting", label: "Meeting", icon: <Mic size={16} />, accent: "#0284c7", tint: "rgba(14, 165, 233, .11)" },
  { id: "team", label: "Team", icon: <Users size={16} />, accent: "#0f766e", tint: "rgba(15, 118, 110, .1)" },
  { id: "projects", label: "Projects", icon: <FolderKanban size={16} />, accent: "#7c3aed", tint: "rgba(124, 58, 237, .1)" },
  { id: "shared", label: "Shared", icon: <Link2 size={16} />, accent: "#db2777", tint: "rgba(236, 72, 153, .1)" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const SHARED_TABS = [
  { id: "mine", label: "Shared by you" },
  { id: "team", label: "Shared with you" },
] as const;
type SharedTabId = (typeof SHARED_TABS)[number]["id"];


const SECTION_IDS = SECTIONS.map((s) => s.id) as readonly string[];

const NAV_COLLAPSED_KEY = "library.navCollapsed";
const LAST_SECTION_KEY = "library.lastSection";

export function LibraryPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [section, setSection] = useState<SectionId>(() => {
    const requested = searchParams.get("section");
    if (requested && SECTION_IDS.includes(requested)) return requested as SectionId;
    const last = localStorage.getItem(LAST_SECTION_KEY);
    return last && SECTION_IDS.includes(last) ? (last as SectionId) : "videos";
  });
  useEffect(() => {
    localStorage.setItem(LAST_SECTION_KEY, section);
  }, [section]);
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem(NAV_COLLAPSED_KEY) === "1");
  useEffect(() => {
    localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsed ? "1" : "0");
  }, [navCollapsed]);
  const { data: storagePreference } = useStoragePreference();
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [errorFor, setErrorFor] = useState<{ id: string; message: string } | null>(null);
  const toast = useToast();
  const stoppedRef = useRef(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [sharedTab, setSharedTab] = useState<SharedTabId>("mine");
  const [shareVideoId, setShareVideoId] = useState<string | null>(null);
  const { data: shareVideo } = useVideo(shareVideoId ?? undefined);
  const [folderError, setFolderError] = useState<{ id: string; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Video | null>(null);
  const [bulkDeleteScope, setBulkDeleteScope] = useState<"all" | "selected" | null>(null);
  const [projectDeleteTarget, setProjectDeleteTarget] = useState<EditProject | null>(null);
  const [projectBulkDeleteScope, setProjectBulkDeleteScope] = useState<"all" | "selected" | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [uploadingKind, setUploadingKind] = useState<"video" | "audio" | null>(null);
  const [importProgress, setImportProgress] = useState<{ percent: number; fileIndex: number; totalFiles: number } | null>(
    null
  );
  const session = useAuthStore((s) => s.session);
  const cloudEnabled = !!session?.user.plan && isBilledTier(session.user.plan.tier);

 
  async function showInFolder(v: Video) {
    setFolderError(null);
    try {
      await SettingsService.showItemInFolder(v.filePath);
    } catch (e) {
      setFolderError({ id: v.id, message: String(e) });
    }
  }

  const { data: videos = [], isLoading } = useVideos(query);
  const deleteVideo = useDeleteVideo();
  const deleteVideos = useDeleteVideos();
  const renameVideo = useRenameVideo();
  const setVideoTranscript = useSetVideoTranscript();
  const importVideos = useImportVideos();
  const { data: autoTranscribe } = useAutoTranscribeSettings();

  const { data: editProjects = [], isLoading: projectsLoading } = useEditProjects();
  const createEditProjectMut = useCreateEditProject();
  const deleteEditProjectMut = useDeleteEditProject();
  const deleteEditProjectsMut = useDeleteEditProjects();
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createSource, setCreateSource] = useState<"library" | "meeting" | "file">("library");
  const [creatingProject, setCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  const sectionProjects = editProjects.filter(
    (p) => !query.trim() || p.title.toLowerCase().includes(query.trim().toLowerCase())
  );

  const sectionVideos =
    section === "meeting" ? videos.filter((v) => v.source === "meeting") : videos.filter((v) => v.source === "record");
  const viewingVideo = videos.find((v) => v.id === viewingId) ?? null;
  const canRetranscribe = !viewingVideo?.transcript || viewingVideo.transcript.engine !== "transcript-import";

  useEffect(() => {
    if (!viewingId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setViewingId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewingId]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [section, query]);

  useEffect(() => LibraryService.onImportProgress(setImportProgress), []);

  const [retranscribeLanguage, setRetranscribeLanguage] = useState(DEFAULT_TRANSCRIPTION_LANGUAGE);
  const [retranscribeModel, setRetranscribeModel] = useState<WhisperModelSize | null>(null);
  const [retranscribeByokId, setRetranscribeByokId] = useState<string | null>(null);
  const [retranscribeUseCloud, setRetranscribeUseCloud] = useState(false);
  const [modelStatuses, setModelStatuses] = useState<WhisperModelStatus[] | null>(null);
  useEffect(() => {
    SettingsService.getWhisperModel().then(setRetranscribeModel).catch(() => {});
    SettingsService.getWhisperModelStatuses().then(setModelStatuses).catch(() => {});
  }, []);
  const downloadedModels = WHISPER_MODELS.filter((m) => {
    const status = modelStatuses?.find((s) => s.size === m.size);
    return status?.downloaded && !status.downloading;
  });
  const effectiveRetranscribeModel = retranscribeModel ?? downloadedModels[0]?.size;

  const { data: llmProfiles = [] } = useLlmProfiles();
  const byokProfiles = llmProfiles.filter((p) => p.capabilities.includes("transcribe"));
  const usingByok = retranscribeByokId !== null && byokProfiles.some((p) => p.id === retranscribeByokId);
  const usingCloud = retranscribeUseCloud && cloudEnabled;
  const hasAnyModel = downloadedModels.length > 0 || byokProfiles.length > 0 || cloudEnabled;

  function handleRetranscribeModelSelectChange(value: string) {
    if (value === "doculigent") {
      setRetranscribeUseCloud(true);
      setRetranscribeByokId(null);
    } else if (value.startsWith("byok:")) {
      setRetranscribeUseCloud(false);
      setRetranscribeByokId(value.slice("byok:".length));
    } else {
      setRetranscribeUseCloud(false);
      setRetranscribeByokId(null);
      setRetranscribeModel(value as WhisperModelSize);
    }
  }


  const [editingSegments, setEditingSegments] = useState<TranscriptSegment[] | null>(null);
  const [savingEdits, setSavingEdits] = useState(false);
  useEffect(() => {
    setEditingSegments(viewingVideo?.transcript?.segments ?? null);
  }, [viewingId, viewingVideo?.transcript]);

  const isDirty =
    !!editingSegments &&
    !!viewingVideo?.transcript &&
    JSON.stringify(editingSegments.map((s) => s.text)) !== JSON.stringify(viewingVideo.transcript.segments.map((s) => s.text));

  function updateSegmentText(index: number, text: string) {
    setEditingSegments((segs) => segs?.map((s, i) => (i === index ? { ...s, text } : s)) ?? segs);
  }


  function handleCancelEdits() {
    setEditingSegments(viewingVideo?.transcript?.segments ?? null);
  }

  async function handleSaveEdits(v: Video) {
    if (!editingSegments || !v.transcript) return;
    setSavingEdits(true);
    try {
      await setVideoTranscript.mutateAsync({ id: v.id, transcript: { ...v.transcript, segments: editingSegments } });
    } finally {
      setSavingEdits(false);
    }
  }

  async function runTranscribe(v: Video, language?: string, modelSize?: WhisperModelSize, byokProfileId?: string) {
    setTranscribingId(v.id);
    setErrorFor(null);
    stoppedRef.current = false;
    try {
      const transcript = await TranscriptionService.transcribe(v.filePath, language, modelSize, byokProfileId);
      await setVideoTranscript.mutateAsync({ id: v.id, transcript });
    } catch (e) {
      if (!stoppedRef.current) {
        const message = friendlyErrorMessage(e);
        setErrorFor({ id: v.id, message });
        toast.error(message, { title: "Transcription failed" });
      }
    } finally {
      setTranscribingId(null);
    }
  }
  async function handleStopTranscribe() {
    stoppedRef.current = true;
    await TranscriptionService.cancel();
  }

  async function handleImport(kind: "video" | "audio") {
    const filePaths = await LibraryService.pickFiles(kind);
    if (filePaths.length === 0) return;
    setUploadingKind(kind);
    setImportProgress({ percent: 0, fileIndex: 0, totalFiles: filePaths.length });
    try {
      const imported = await importVideos.mutateAsync({ filePaths, kind });
      toast.success(`${imported.length} file${imported.length === 1 ? "" : "s"} imported`);
      const autoTranscribeThisKind =
        autoTranscribe?.all || (kind === "video" ? autoTranscribe?.videoImport : autoTranscribe?.audioImport);
      if (autoTranscribeThisKind) {
        for (const v of imported) {
          await runTranscribe(v);
        }
      }
    } catch (e) {
      toast.error(friendlyErrorMessage(e), { title: "Import failed" });
    } finally {
      setUploadingKind(null);
      setImportProgress(null);
    }
  }

  async function handleTranscribeClick(v: Video) {
    setViewingId(v.id);
    if (v.transcript) return;
    if (!hasAnyModel) return;
    await runTranscribe(v);
  }

  function handleRetranscribeClick(v: Video) {
    if (usingByok) return runTranscribe(v, retranscribeLanguage, undefined, retranscribeByokId!);
    return runTranscribe(v, retranscribeLanguage, effectiveRetranscribeModel);
  }

  function startRename(v: Video) {
    setTitleDraft(v.title);
    setRenamingId(v.id);
  }

  async function saveRename(v: Video) {
    if (!titleDraft.trim()) return;
    await renameVideo.mutateAsync({ id: v.id, title: titleDraft.trim() });
    setRenamingId(null);
  }

  function handleDelete(v: Video) {
    setDeleteTarget(v);
  }

  function confirmDelete(keepFile: boolean) {
    if (!deleteTarget) return;
    deleteVideo.mutate({ id: deleteTarget.id, keepFile });
    setDeleteTarget(null);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    if (section === "projects") {
      setSelectedIds(new Set(sectionProjects.map((p) => p.id)));
      return;
    }
    setSelectedIds(new Set(sectionVideos.map((v) => v.id)));
  }

  function deselectAll() {
    setSelectedIds(new Set());
  }

  function handleBulkDelete(scope: "all" | "selected") {
    if (section === "projects") {
      const hasTargets =
        scope === "all" ? sectionProjects.length > 0 : sectionProjects.some((p) => selectedIds.has(p.id));
      if (!hasTargets) return;
      setProjectBulkDeleteScope(scope);
      return;
    }
    const hasTargets =
      scope === "all" ? sectionVideos.length > 0 : sectionVideos.some((v) => selectedIds.has(v.id));
    if (!hasTargets) return;
    setBulkDeleteScope(scope);
  }

  const bulkDeleteTargetIds =
    bulkDeleteScope === "all"
      ? sectionVideos.map((v) => v.id)
      : bulkDeleteScope === "selected"
        ? sectionVideos.filter((v) => selectedIds.has(v.id)).map((v) => v.id)
        : [];

  function confirmBulkDelete(keepFile: boolean) {
    if (bulkDeleteTargetIds.length === 0) {
      setBulkDeleteScope(null);
      return;
    }
    deleteVideos.mutate({ ids: bulkDeleteTargetIds, keepFile });
    setSelectedIds(new Set());
    setBulkDeleteScope(null);
  }

  const projectBulkDeleteTargetIds =
    projectBulkDeleteScope === "all"
      ? sectionProjects.map((p) => p.id)
      : projectBulkDeleteScope === "selected"
        ? sectionProjects.filter((p) => selectedIds.has(p.id)).map((p) => p.id)
        : [];

  function confirmProjectBulkDelete() {
    if (projectBulkDeleteTargetIds.length === 0) {
      setProjectBulkDeleteScope(null);
      return;
    }
    deleteEditProjectsMut.mutate(projectBulkDeleteTargetIds);
    setSelectedIds(new Set());
    setProjectBulkDeleteScope(null);
  }

  function openCreateProject() {
    setCreateProjectError(null);
    setCreateSource("library");
    setCreateProjectOpen(true);
  }

  function closeCreateProject() {
    if (creatingProject) return;
    setCreateProjectOpen(false);
    setCreateProjectError(null);
  }

  async function finishCreateProject(title: string, source?: EditProjectSource) {
    setCreatingProject(true);
    setCreateProjectError(null);
    try {
      const created = await createEditProjectMut.mutateAsync({ title, source });
      setCreateProjectOpen(false);
      navigate(`/edit/${created.id}`);
    } catch (e) {
      setCreateProjectError(friendlyErrorMessage(e));
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleCreateFromFile(kind: "video" | "audio") {
    setCreateProjectError(null);
    const filePaths = await LibraryService.pickFiles(kind, false);
    if (filePaths.length === 0) return;
    const base = fileName(filePaths[0]).replace(/\.[^./\\]+$/, "");
    await finishCreateProject(base || "Untitled project", { kind: "file", filePath: filePaths[0] });
  }

  const libraryVideosForCreate = videos.filter((v) => v.source === "record");
  const meetingVideosForCreate = videos.filter((v) => v.source === "meeting");

  const activeSection = SECTIONS.find((s) => s.id === section)!;
  const canBulkDelete = section === "videos" || section === "meeting";
  const selectedCount =
    section === "projects"
      ? sectionProjects.filter((p) => selectedIds.has(p.id)).length
      : sectionVideos.filter((v) => selectedIds.has(v.id)).length;

  return (
    <div className="library-layout">
      <div className="library-body">
        <nav className={navCollapsed ? "library-nav collapsed" : "library-nav"}>
          <button
            type="button"
            className="library-nav-toggle"
            title={navCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setNavCollapsed((c) => !c)}
          >
            {navCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === section ? "library-nav-item active" : "library-nav-item"}
              style={{ "--nav-accent": s.accent, "--nav-tint": s.tint } as CSSProperties}
              title={navCollapsed ? s.label : undefined}
              onClick={() => {
                setSection(s.id);
                if (s.id !== "shared") setShareVideoId(null);
              }}
            >
              <span className="library-nav-icon">{s.icon}</span>
              {!navCollapsed && s.label}
            </button>
          ))}
        </nav>

        <section
          className="panel library-list-panel"
          style={{ "--section-accent": activeSection.accent, "--section-tint": activeSection.tint } as CSSProperties}
        >
          {section === "shared" ? (
            storagePreference?.provider === "s3" ? (
              <>
                <div className="library-section-head">
                  <span className="library-section-icon">{activeSection.icon}</span>
                  <div>
                    <h1>Shared</h1>
                    <p className="muted">
                      Files uploaded via Share, or dropped here directly — stored under{" "}
                      <code>{storagePreference.s3?.folder || "folder"}/shared/</code> in your S3 bucket.
                    </p>
                  </div>
                </div>

                {shareVideoId && (
                  <ShareToStoragePanel
                    video={shareVideo ? { filePath: shareVideo.filePath, title: shareVideo.title } : undefined}
                    onClose={() => setShareVideoId(null)}
                  />
                )}

                <StorageFileBrowser teamId="" showDropzone={!shareVideoId} />
              </>
            ) : (
              <>
                <div className="library-section-head">
                  <span className="library-section-icon">{activeSection.icon}</span>
                  <div>
                    <h1>Shared</h1>
                    <p className="muted">Recordings shared through your doculigent.com account.</p>
                  </div>
                </div>

                <div className="shared-subnav">
                  {SHARED_TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={t.id === sharedTab ? "shared-tab active" : "shared-tab"}
                      onClick={() => setSharedTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="shared-empty">
                  {session ? (
                    <p className="muted">
                      {sharedTab === "mine"
                        ? "Nothing shared yet. Sharing (the share icon on a recording) is still being built for doculigent.com accounts."
                        : "Recordings shared with you will show up here once doculigent.com sharing is live."}
                    </p>
                  ) : (
                    <p className="muted">
                      Sign in with doculigent.com to see shared recordings — <Link to="/account">go to Account</Link>.
                    </p>
                  )}
                </div>
              </>
            )
          ) : section === "team" ? (
            <>
              <div className="library-section-head">
                <span className="library-section-icon">{activeSection.icon}</span>
                <div>
                  <h1>Team</h1>
                  <p className="muted">Create teams, invite members, and share files through your doculigent.com account.</p>
                </div>
              </div>

              <TeamsSection />
            </>
          ) : section === "projects" ? (
            <>
              <div className="library-section-head">
                <span className="library-section-icon">{activeSection.icon}</span>
                <div>
                  <h1>Projects</h1>
                  <p className="muted">Edit projects, stored locally — open one to keep working.</p>
                </div>
                <button type="button" className="library-upload-btn" onClick={openCreateProject}>
                  <Plus size={16} />
                  New Project
                </button>
              </div>

              <div className="library-toolbar">
                <input
                  type="search"
                  placeholder="Search projects…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button type="button" onClick={selectAll} disabled={sectionProjects.length === 0}>
                  Select All
                </button>
                <button type="button" onClick={deselectAll} disabled={selectedCount === 0}>
                  Deselect All
                </button>
                <span className="muted library-selection-count">
                  {selectedCount > 0 ? `${selectedCount} selected` : ""}
                </span>
                <button
                  type="button"
                  className="danger"
                  disabled={selectedCount === 0}
                  onClick={() => handleBulkDelete("selected")}
                >
                  Delete Selected
                </button>
                <button
                  type="button"
                  className="danger library-delete-all"
                  disabled={sectionProjects.length === 0}
                  onClick={() => handleBulkDelete("all")}
                >
                  Delete All
                </button>
              </div>

              {projectsLoading && <p className="muted">Loading…</p>}
              {!projectsLoading && sectionProjects.length === 0 && (
                <p className="muted">No projects yet — head to the Edit tab to start one.</p>
              )}

              <div className="library-grid">
                {sectionProjects.map((p) => (
                  <div
                    key={p.id}
                    className={selectedIds.has(p.id) ? "video-card selected" : "video-card"}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/edit/${p.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") navigate(`/edit/${p.id}`);
                    }}
                  >
                    <div className="thumb">
                      <label className="video-card-select" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(p.id)}
                          onChange={() => toggleSelect(p.id)}
                        />
                      </label>
                      <div className="thumb-project">
                        <FolderKanban size={32} />
                      </div>
                    </div>

                    <div className="meta">
                      <h3>{p.title}</h3>
                      <p className="muted sub">Updated {new Date(p.updatedAt).toLocaleDateString()}</p>
                    </div>

                    <div className="video-card-icons">
                      <button
                        type="button"
                        title="Open in Editor"
                        className="icon-btn icon-btn-open"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/edit/${p.id}`);
                        }}
                      >
                        <SquarePlay size={20} />
                      </button>
                      <button
                        type="button"
                        title="Delete project"
                        className="icon-btn icon-btn-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          setProjectDeleteTarget(p);
                        }}
                      >
                        <Trash2 size={20} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="library-section-head">
                <span className="library-section-icon">{activeSection.icon}</span>
                <div>
                  <h1>{activeSection.label}</h1>
                  <p className="muted">
                    {section === "meeting" ? "Audio recorded from the Meeting tab." : "Every recording, stored locally."}
                  </p>
                </div>
                {section === "videos" && (
                  <button
                    type="button"
                    className="library-upload-btn"
                    disabled={uploadingKind !== null}
                    onClick={() => handleImport("video")}
                  >
                    <Clapperboard size={16} />
                    {uploadingKind === "video" ? "Importing…" : "Import Video"}
                  </button>
                )}
                {section === "meeting" && (
                  <button
                    type="button"
                    className="library-upload-btn"
                    disabled={uploadingKind !== null}
                    onClick={() => handleImport("audio")}
                  >
                    <Mic size={16} />
                    {uploadingKind === "audio" ? "Importing…" : "Import Meeting / Audio"}
                  </button>
                )}
              </div>

              <div className="library-toolbar">
                <input
                  type="search"
                  placeholder="Search titles & transcripts…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {canBulkDelete && (
                  <>
                    <button type="button" onClick={selectAll} disabled={sectionVideos.length === 0}>
                      Select All
                    </button>
                    <button type="button" onClick={deselectAll} disabled={selectedCount === 0}>
                      Deselect All
                    </button>
                    <span className="muted library-selection-count">
                      {selectedCount > 0 ? `${selectedCount} selected` : ""}
                    </span>
                    <button
                      type="button"
                      className="danger"
                      disabled={selectedCount === 0}
                      onClick={() => handleBulkDelete("selected")}
                    >
                      Delete Selected
                    </button>
                    <button
                      type="button"
                      className="danger library-delete-all"
                      disabled={sectionVideos.length === 0}
                      onClick={() => handleBulkDelete("all")}
                    >
                      Delete All
                    </button>
                  </>
                )}
              </div>

              {isLoading && <p className="muted">Loading…</p>}
              {!isLoading && sectionVideos.length === 0 && (
                <p className="muted">
                  {section === "meeting"
                    ? "No meetings recorded yet — head to the Meeting tab."
                    : "No recordings yet — head to the Record tab."}
                </p>
              )}

              <div className="library-grid">
                {sectionVideos.map((v) => (
                  <div key={v.id} className={selectedIds.has(v.id) ? "video-card selected" : "video-card"}>
                    <div className="thumb">
                      {canBulkDelete && (
                        <label className="video-card-select" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(v.id)}
                            onChange={() => toggleSelect(v.id)}
                          />
                        </label>
                      )}
                      {v.source === "meeting" ? (
                        <div className="thumb-audio">
                          <Mic size={32} />
                        </div>
                      ) : (
                        <video
                          src={mediaUrl(v.filePath)}
                          muted
                          preload="metadata"
                          playsInline
                          onLoadedMetadata={showThumbnailFrame}
                        />
                      )}
                      {v.transcript && <span className="thumb-badge">Transcribed</span>}
                    </div>

                    <div className="meta">
                      {renamingId === v.id ? (
                        <input
                          className="video-rename-input"
                          value={titleDraft}
                          autoFocus
                          onChange={(e) => setTitleDraft(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && saveRename(v)}
                        />
                      ) : (
                        <h3>{v.title}</h3>
                      )}
                      <p className="muted sub">
                        {formatDuration(v.durationSecs)} · {new Date(v.createdAt).toLocaleDateString()}
                      </p>
                    </div>

                    <div className="video-card-icons">
                      {renamingId === v.id ? (
                        <>
                          <button
                            type="button"
                            title="Save"
                            className="icon-btn icon-btn-save"
                            onClick={() => saveRename(v)}
                          >
                            <Check size={20} />
                          </button>
                          <button
                            type="button"
                            title="Cancel"
                            className="icon-btn icon-btn-cancel"
                            onClick={() => setRenamingId(null)}
                          >
                            <X size={20} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            title={fileName(v.filePath)}
                            className="icon-btn icon-btn-folder"
                            onClick={() => showInFolder(v)}
                          >
                            <FolderOpen size={20} />
                          </button>
                          <button
                            type="button"
                            title={v.transcript ? "Re-transcribe" : "Transcribe"}
                            className="icon-btn icon-btn-transcribe"
                            disabled={transcribingId === v.id}
                            onClick={() => handleTranscribeClick(v)}
                          >
                            {transcribingId === v.id ? "…" : <FileText size={20} />}
                          </button>
                          <button
                            type="button"
                            title="Rename"
                            className="icon-btn icon-btn-rename"
                            onClick={() => startRename(v)}
                          >
                            <Pencil size={20} />
                          </button>
                          <button
                            type="button"
                            title="Share"
                            className="icon-btn icon-btn-share"
                            onClick={() => {
                              if (storagePreference?.provider === "s3") {
                                setSection("shared");
                                setShareVideoId(v.id);
                              } else {
                                navigate(`/library/${v.id}/share`);
                              }
                            }}
                          >
                            <Link2 size={20} />
                          </button>
                          <button
                            type="button"
                            title="Delete recording"
                            className="icon-btn icon-btn-delete"
                            onClick={() => handleDelete(v)}
                          >
                            <Trash2 size={20} />
                          </button>
                          {/* Pushed to the far right (see .icon-btn-ai's margin-left:auto)
                              rather than sitting in the same cluster as the other actions —
                              jumps to the AI Assistant tab with this recording already
                              attached (see AiAssistantPage.tsx's location.state handling). */}
                          <button
                            type="button"
                            title="Ask AI about this recording"
                            className="icon-btn icon-btn-ai"
                            onClick={() => navigate("/ai", { state: { videoId: v.id } })}
                          >
                            <Bot size={20} />
                          </button>
                        </>
                      )}
                    </div>

                    {folderError?.id === v.id && <p className="error video-card-error">{folderError.message}</p>}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {deleteTarget && (
        <div className="modal-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete "{deleteTarget.title}"?</h2>
            <p className="muted">
              You can remove it from your library and keep the file on disk, or delete both the library entry and
              the file itself. This can't be undone.
            </p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button type="button" onClick={() => confirmDelete(true)}>
                Delete from Library
              </button>
              <button type="button" className="danger" onClick={() => confirmDelete(false)}>
                Delete Everything
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkDeleteScope && (
        <div className="modal-backdrop" onClick={() => setBulkDeleteScope(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              Delete {bulkDeleteTargetIds.length}{" "}
              {bulkDeleteTargetIds.length === 1 ? "recording" : "recordings"}?
            </h2>
            <p className="muted">
              You can remove {bulkDeleteScope === "all" ? "every recording" : "the selected recordings"} from
              your library and keep the files on disk, or delete both the library entries and the files
              themselves. This can't be undone.
            </p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setBulkDeleteScope(null)}>
                Cancel
              </button>
              <button type="button" onClick={() => confirmBulkDelete(true)}>
                Delete from Library
              </button>
              <button type="button" className="danger" onClick={() => confirmBulkDelete(false)}>
                Delete from Disk
              </button>
            </div>
          </div>
        </div>
      )}

      {projectDeleteTarget && (
        <div className="modal-backdrop" onClick={() => setProjectDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete "{projectDeleteTarget.title}"?</h2>
            <p className="muted">This deletes the project and its files. This can't be undone.</p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setProjectDeleteTarget(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  deleteEditProjectMut.mutate(projectDeleteTarget.id);
                  setProjectDeleteTarget(null);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {projectBulkDeleteScope && (
        <div className="modal-backdrop" onClick={() => setProjectBulkDeleteScope(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              Delete {projectBulkDeleteTargetIds.length}{" "}
              {projectBulkDeleteTargetIds.length === 1 ? "project" : "projects"}?
            </h2>
            <p className="muted">This can't be undone.</p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setProjectBulkDeleteScope(null)}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={confirmProjectBulkDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {createProjectOpen && (
        <div className="modal-backdrop" onClick={closeCreateProject}>
          <div className="modal create-project-modal" onClick={(e) => e.stopPropagation()}>
            <h2>New Project</h2>
            <p className="muted">
              Start from an existing recording or a file — the project name is generated from what you pick.
            </p>

            <div className="create-project-source-picker">
              <button
                type="button"
                className={createSource === "library" ? "create-project-source-tile active" : "create-project-source-tile"}
                onClick={() => setCreateSource("library")}
              >
                <Clapperboard size={48} />
                <span>Videos</span>
              </button>
              <button
                type="button"
                className={createSource === "meeting" ? "create-project-source-tile active" : "create-project-source-tile"}
                onClick={() => setCreateSource("meeting")}
              >
                <Mic size={48} />
                <span>Meeting</span>
              </button>
              <button
                type="button"
                className={createSource === "file" ? "create-project-source-tile active" : "create-project-source-tile"}
                onClick={() => setCreateSource("file")}
              >
                <FileUp size={48} />
                <span>File</span>
              </button>
            </div>

            {createSource === "file" ? (
              <div className="create-project-file-options">
                <button type="button" disabled={creatingProject} onClick={() => handleCreateFromFile("video")}>
                  <Clapperboard size={16} />
                  Choose video file…
                </button>
                <button type="button" disabled={creatingProject} onClick={() => handleCreateFromFile("audio")}>
                  <Mic size={16} />
                  Choose audio file…
                </button>
              </div>
            ) : (
              <div className="create-project-source-list">
                {(createSource === "library" ? libraryVideosForCreate : meetingVideosForCreate).map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className="create-project-source-item"
                    disabled={creatingProject}
                    onClick={() => finishCreateProject(v.title, { kind: "video", videoId: v.id })}
                  >
                    <span className="create-project-source-title">{v.title}</span>
                    <span className="muted">{new Date(v.createdAt).toLocaleDateString()}</span>
                  </button>
                ))}
                {(createSource === "library" ? libraryVideosForCreate : meetingVideosForCreate).length === 0 && (
                  <p className="muted">
                    {createSource === "library" ? "No videos in your library yet." : "No meetings recorded yet."}
                  </p>
                )}
              </div>
            )}

            {creatingProject && <p className="muted">Creating…</p>}
            {createProjectError && <p className="error">{createProjectError}</p>}

            <div className="actions modal-actions">
              <button type="button" onClick={closeCreateProject} disabled={creatingProject}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* No onClick-to-dismiss on the backdrop (unlike the modals above) — closing it
          wouldn't stop the import running in the main process, so letting it be dismissed
          would just make the page lie about whether anything's still happening. */}
      {importProgress && (
        <div className="modal-backdrop">
          <div className="modal import-progress-modal">
            <h2>Importing…</h2>
            {importProgress.totalFiles > 1 && (
              <p className="muted">
                File {Math.min(importProgress.fileIndex + 1, importProgress.totalFiles)} of{" "}
                {importProgress.totalFiles}
              </p>
            )}
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${importProgress.percent}%` }} />
            </div>
            <p className="muted progress-bar-label">{importProgress.percent}%</p>
          </div>
        </div>
      )}

      {viewingVideo && (
        <div className="transcript-drawer-backdrop" onClick={() => setViewingId(null)}>
          <aside className="transcript-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="transcript-drawer-header">
              <h2>{viewingVideo.title}</h2>
              <button type="button" className="icon-btn" title="Close (Esc)" onClick={() => setViewingId(null)}>
                <X size={20} />
              </button>
            </div>

            {canRetranscribe && (
              <>
                <fieldset className="field retranscribe-controls" disabled={transcribingId === viewingVideo.id}>
                  <legend>Transcribe with</legend>

                  <div className="retranscribe-row">
                    <label className="field">
                      <span>Language</span>
                      <select value={retranscribeLanguage} onChange={(e) => setRetranscribeLanguage(e.target.value)}>
                        {TRANSCRIPTION_LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field">
                      <span>Model</span>
                      {hasAnyModel ? (
                        <select
                          value={usingCloud ? "doculigent" : usingByok ? `byok:${retranscribeByokId}` : (effectiveRetranscribeModel ?? "")}
                          onChange={(e) => handleRetranscribeModelSelectChange(e.target.value)}
                        >
                          {cloudEnabled && <option value="doculigent">Doculigent (cloud)</option>}
                          {downloadedModels.map((m) => (
                            <option key={m.size} value={m.size}>
                              {m.label}
                            </option>
                          ))}
                          {byokProfiles.map((p) => (
                            <option key={p.id} value={`byok:${p.id}`}>
                              {p.name || "BYOK"}
                            </option>
                          ))}
                        </select>
                      ) : (
                        modelStatuses && (
                          <span className="muted field-hint-inline">
                            No models configured — set one up in{" "}
                            <Link to="/settings">Settings &gt; Models</Link>.
                          </span>
                        )
                      )}
                    </label>
                  </div>
                </fieldset>

                {/* Deliberately outside the fieldset above — its `disabled` while transcribing
                    is meant to lock the language/model pickers, not the Stop button, which
                    needs to stay clickable for exactly that duration. */}
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => handleRetranscribeClick(viewingVideo)}
                    disabled={transcribingId === viewingVideo.id || !hasAnyModel}
                  >
                    {transcribingId === viewingVideo.id
                      ? "Transcribing…"
                      : viewingVideo.transcript
                        ? "Re-transcribe"
                        : "Transcribe"}
                  </button>
                  {transcribingId === viewingVideo.id && (
                    <button type="button" className="danger" onClick={handleStopTranscribe}>
                      Stop
                    </button>
                  )}
                </div>
              </>
            )}

            {errorFor?.id === viewingVideo.id && <p className="error">{errorFor.message}</p>}

            {editingSegments && editingSegments.length > 0 && (
              <>
                <div className="transcript-drawer-header">
                  <h3>Transcript</h3>
                  <div className="actions">
                    {isDirty && (
                      <button type="button" onClick={handleCancelEdits} disabled={savingEdits}>
                        Cancel
                      </button>
                    )}
                    <button
                      type="button"
                      className="primary"
                      onClick={() => handleSaveEdits(viewingVideo)}
                      disabled={savingEdits || !isDirty}
                    >
                      {savingEdits ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>

                <div className="segments">
                  {editingSegments.map((seg, i) => (
                    <div key={i} className="segment">
                      <span className="ts">{formatDuration(seg.start)}</span>
                      <span className="spk">{seg.speaker}</span>
                      <textarea
                        className="txt segment-edit"
                        value={seg.text}
                        onChange={(e) => updateSegmentText(i, e.target.value)}
                        rows={Math.max(1, Math.ceil(seg.text.length / 40))}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}

            {!viewingVideo.transcript && transcribingId !== viewingVideo.id && !errorFor && (
              <p className="muted">No transcript yet.</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
