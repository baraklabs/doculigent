import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { CutRange, EditProject } from "@shared/types/models";
import { mediaUrl } from "@shared/constants/media";
import { useVideo, useVideos } from "../hooks/useVideos";
import {
  useCreateEditProject,
  useEditProject,
  useExportEditProject,
  useUpdateEditProject,
} from "../hooks/useEditProjects";
import { EditProjectService } from "../services/editProjects/EditProjectService";
import { SettingsService } from "../services/settings/SettingsService";
import { detectMediaKind } from "../lib/media";
import { advancePastGaps, computeKeepRanges, mergeCuts } from "../lib/editRanges";
import { EditTimeline } from "../components/EditTimeline";
import "./EditPage.css";

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface PickedSource {
  filePath: string;
  kind: "video" | "audio";
  videoId: string | null;
  durationSecs: number;
}

function NewEditProjectScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const prefillVideoId = searchParams.get("videoId") ?? undefined;
  const { data: prefillVideo } = useVideo(prefillVideoId);

  const [name, setName] = useState("");
  const [source, setSource] = useState<PickedSource | null>(null);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const createProject = useCreateEditProject();
  const { data: libraryVideos = [] } = useVideos(libraryQuery);

  useEffect(() => {
    if (!prefillVideo) return;
    setSource({
      filePath: prefillVideo.filePath,
      kind: prefillVideo.source === "meeting" ? "audio" : "video",
      videoId: prefillVideo.id,
      durationSecs: prefillVideo.durationSecs,
    });
    setName((n) => n || prefillVideo.title);
  }, [prefillVideo]);

  async function pickFromComputer() {
    setError(null);
    const filePath = await EditProjectService.pickImportFile();
    if (!filePath) return;
    await detectAndSetComputerFile(filePath);
  }

  async function detectAndSetComputerFile(filePath: string) {
    setDetecting(true);
    setError(null);
    try {
      const detected = await detectMediaKind(filePath);
      setSource({ filePath, kind: detected.kind, videoId: null, durationSecs: detected.durationSecs });
      setName((n) => n || (filePath.split(/[\\/]/).pop() ?? filePath));
    } catch (e) {
      setError(String(e));
    } finally {
      setDetecting(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const filePath = window.api.system.getPathForFile(file);
    void detectAndSetComputerFile(filePath);
  }

  function pickFromLibrary(videoId: string, filePath: string, videoSource: "record" | "meeting", durationSecs: number, title: string) {
    setSource({ filePath, kind: videoSource === "meeting" ? "audio" : "video", videoId, durationSecs });
    setName((n) => n || title);
  }

  async function createAndOpen() {
    if (!name.trim() || !source) return;
    const project = await createProject.mutateAsync({
      name: name.trim(),
      sourceFilePath: source.filePath,
      sourceKind: source.kind,
      sourceVideoId: source.videoId,
      durationSecs: source.durationSecs,
    });
    navigate(`/edit/${project.id}`);
  }

  if (prefillVideoId && !prefillVideo) {
    return (
      <section className="panel">
        <h1>Edit</h1>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="panel editor">
      <h1>Edit</h1>
      <p className="muted">Trim, cut, and export a video or audio clip.</p>

      <label className="field">
        <span>Project name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My clip"
          autoFocus
        />
      </label>

      {!prefillVideoId && (
        <div className="edit-import-options">
          <div
            className={dragOver ? "edit-import-card drag-over" : "edit-import-card"}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <h3>Import from computer</h3>
            <p className="muted">Choose a file, or drag & drop a video/audio file here.</p>
            <button type="button" onClick={pickFromComputer} disabled={detecting}>
              {detecting ? "Reading file…" : "Choose file…"}
            </button>
          </div>

          <div className="edit-import-card">
            <h3>Import from Library</h3>
            <p className="muted">Pick one of your existing recordings.</p>
            <input
              type="search"
              placeholder="Search recordings…"
              value={libraryQuery}
              onChange={(e) => setLibraryQuery(e.target.value)}
            />
            <div className="edit-import-library-grid">
              {libraryVideos.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={source?.videoId === v.id ? "edit-import-library-item active" : "edit-import-library-item"}
                  onClick={() => pickFromLibrary(v.id, v.filePath, v.source, v.durationSecs, v.title)}
                >
                  <span>{v.source === "meeting" ? "🎧" : "🎬"}</span>
                  <span className="edit-import-library-title">{v.title}</span>
                  <span className="muted">{formatDuration(v.durationSecs)}</span>
                </button>
              ))}
              {libraryVideos.length === 0 && <p className="muted">No recordings yet.</p>}
            </div>
          </div>
        </div>
      )}

      {source && (
        <p className="muted">
          Selected: {source.filePath.split(/[\\/]/).pop()} · {source.kind === "video" ? "Video" : "Audio"} ·{" "}
          {formatDuration(source.durationSecs)}
        </p>
      )}

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button
          className="primary"
          onClick={createAndOpen}
          disabled={!name.trim() || !source || createProject.isPending}
        >
          {createProject.isPending ? "Creating…" : "Create project"}
        </button>
      </div>

      {createProject.isError && <p className="error">{String(createProject.error)}</p>}
    </section>
  );
}

function EditProjectWorkspace({ project }: { project: EditProject }) {
  const navigate = useNavigate();
  const updateProject = useUpdateEditProject();
  const exportProject = useExportEditProject();
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  function getMedia(): HTMLMediaElement | null {
    return project.sourceKind === "video" ? videoRef.current : audioRef.current;
  }

  const [fileState, setFileState] = useState<"checking" | "ok" | "missing">("checking");
  const [relinking, setRelinking] = useState(false);
  const [relinkError, setRelinkError] = useState<string | null>(null);

  useEffect(() => {
    setFileState("checking");
    EditProjectService.fileExists(project.sourceFilePath).then((exists) => setFileState(exists ? "ok" : "missing"));
  }, [project.sourceFilePath]);

  const [nameDraft, setNameDraft] = useState(project.name);
  const [trimStart, setTrimStart] = useState(project.trimStart);
  const [trimEnd, setTrimEnd] = useState(project.trimEnd);
  const [cuts, setCuts] = useState<CutRange[]>(project.cuts);
  useEffect(() => {
    setNameDraft(project.name);
    setTrimStart(project.trimStart);
    setTrimEnd(project.trimEnd);
    setCuts(project.cuts);
  }, [project.id]);

  // Read by the timeupdate handler below — refs avoid re-registering the listener (and
  // avoid stale closures) every time a handle moves.
  const previewRef = useRef({ previewing: false, trimStart, trimEnd, cuts });
  previewRef.current = { previewing: previewRef.current.previewing, trimStart, trimEnd, cuts };
  const [previewing, setPreviewing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  // Trim handles also scrub the preview to the dragged position — the same "show the
  // frame you're trimming to" feedback a real NLE's trim handles give.
  function changeTrimStart(value: number) {
    const next = Math.min(value, trimEnd - 0.1);
    setTrimStart(next);
    setCuts((c) => mergeCuts(c, next, trimEnd));
    const media = getMedia();
    if (media) media.currentTime = next;
    setCurrentTime(next);
  }

  function changeTrimEnd(value: number) {
    const next = Math.max(value, trimStart + 0.1);
    setTrimEnd(next);
    setCuts((c) => mergeCuts(c, trimStart, next));
    const media = getMedia();
    if (media) media.currentTime = next;
    setCurrentTime(next);
  }

  function handleSeek(value: number) {
    const media = getMedia();
    if (media) media.currentTime = value;
    setCurrentTime(value);
  }

  function togglePreview() {
    const media = getMedia();
    if (!media) return;
    if (previewing) {
      media.pause();
      setPreviewing(false);
      previewRef.current.previewing = false;
    } else {
      media.currentTime = trimStart;
      void media.play();
      setPreviewing(true);
      previewRef.current.previewing = true;
    }
  }

  function stopPreview(media: HTMLMediaElement) {
    media.pause();
    media.currentTime = trimStart;
    previewRef.current.previewing = false;
    setPreviewing(false);
  }

  function handleTimeUpdate() {
    const media = getMedia();
    if (!media) return;
    setCurrentTime(media.currentTime);

    const p = previewRef.current;
    if (!p.previewing) return;
    const next = advancePastGaps(media.currentTime, computeKeepRanges(p.trimStart, p.trimEnd, p.cuts));
    if (next === null) stopPreview(media);
    else if (Math.abs(next - media.currentTime) > 0.01) media.currentTime = next;
  }
  
  function handleEnded() {
    const media = getMedia();
    if (media && previewRef.current.previewing) stopPreview(media);
  }

  function keepRanges(): [number, number][] {
    return computeKeepRanges(trimStart, trimEnd, cuts);
  }

  async function handleSave() {
    await updateProject.mutateAsync({
      id: project.id,
      patch: {
        name: nameDraft.trim() || project.name,
        trimStart,
        trimEnd,
        cuts,
      },
    });
  }

  async function handleExport() {
    await exportProject.mutateAsync({ id: project.id, keepRanges: keepRanges() });
  }

  async function handleRelink() {
    setRelinkError(null);
    setRelinking(true);
    try {
      const filePath = await EditProjectService.pickImportFile();
      if (!filePath) return;
      await updateProject.mutateAsync({ id: project.id, patch: { sourceFilePath: filePath } });
    } catch (e) {
      setRelinkError(String(e));
    } finally {
      setRelinking(false);
    }
  }

  if (fileState === "checking") {
    return (
      <section className="panel editor">
        <h1>{project.name}</h1>
        <p className="muted">Checking source file…</p>
      </section>
    );
  }

  if (fileState === "missing") {
    return (
      <section className="panel editor">
        <h1>{project.name}</h1>
        <p className="error">Original file not found: {project.sourceFilePath}</p>
        <p className="muted">It may have been moved, renamed, or deleted.</p>
        <div className="actions">
          <button className="primary" onClick={handleRelink} disabled={relinking}>
            {relinking ? "Relinking…" : "Relink file…"}
          </button>
          <button onClick={() => navigate("/library?section=projects")}>Close</button>
        </div>
        {relinkError && <p className="error">{relinkError}</p>}
      </section>
    );
  }

  const duration = project.durationSecs;
  const exportedPath = exportProject.data?.outputPath ?? null;

  return (
    <section className="panel editor">
      <p className="muted">
        <Link to="/library?section=projects">← Back to Library</Link>
      </p>
      <h1>{project.name}</h1>
      <p className="muted">
        {project.sourceKind === "video" ? "Video" : "Audio"} · File: {project.sourceFilePath}
      </p>

      {project.sourceKind === "video" ? (
        <video
          ref={videoRef}
          src={mediaUrl(project.sourceFilePath)}
          controls
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
          className="edit-preview-video"
        />
      ) : (
        <audio
          ref={audioRef}
          src={mediaUrl(project.sourceFilePath)}
          controls
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleEnded}
          className="edit-preview-audio"
        />
      )}

      <EditTimeline
        duration={duration}
        currentTime={currentTime}
        trimStart={trimStart}
        trimEnd={trimEnd}
        cuts={cuts}
        onTrimStartChange={changeTrimStart}
        onTrimEndChange={changeTrimEnd}
        onCutsChange={setCuts}
        onSeek={handleSeek}
      />
      <p className="muted field-hint">
        Drag the outer handles to trim. Switch to ✂ Cut, then drag anywhere on the track to remove a section — add as
        many as you like.
      </p>

      <label className="field">
        <span>Project name</span>
        <input type="text" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
      </label>

      <div className="actions">
        <button onClick={togglePreview}>{previewing ? "⏸ Pause preview" : "▶ Preview edit"}</button>
        <button onClick={handleSave} disabled={updateProject.isPending}>
          {updateProject.isPending ? "Saving…" : "Save"}
        </button>
        <button className="primary" onClick={handleExport} disabled={exportProject.isPending}>
          {exportProject.isPending ? "Exporting…" : "Export"}
        </button>
      </div>

      {updateProject.isError && <p className="error">{String(updateProject.error)}</p>}
      {exportProject.isError && <p className="error">{String(exportProject.error)}</p>}
      {exportedPath && (
        <p className="muted">
          Exported to {exportedPath} —{" "}
          <button type="button" onClick={() => void SettingsService.showItemInFolder(exportedPath)}>
            Show in folder
          </button>
        </p>
      )}
    </section>
  );
}

export function EditPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: project, isLoading } = useEditProject(projectId);

  if (!projectId) return <NewEditProjectScreen />;

  if (isLoading) {
    return (
      <section className="panel">
        <h1>Edit</h1>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  if (!project) {
    return (
      <section className="panel">
        <h1>Edit</h1>
        <p className="muted">Project not found.</p>
      </section>
    );
  }

  return <EditProjectWorkspace project={project} />;
}
