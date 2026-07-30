import { useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Bot, Clapperboard, Mic, FolderKanban, Link2, FileText, Check, X, FolderOpen, Pencil, Trash2 } from "lucide-react";
import type { TranscriptSegment, Video } from "@shared/types/models";
import { mediaUrl } from "@shared/constants/media";
import { DEFAULT_TRANSCRIPTION_LANGUAGE, TRANSCRIPTION_LANGUAGES } from "@shared/constants/languages";
import { WHISPER_MODELS } from "@shared/constants/whisperModels";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";
import { isBilledTier } from "@shared/constants/plans";
import { useDeleteVideo, useDeleteVideos, useRenameVideo, useSetVideoTranscript, useVideos } from "../hooks/useVideos";
import { useLlmProfiles } from "../hooks/useLlmProfiles";
import { TranscriptionService } from "../services/transcription/TranscriptionService";
import { SettingsService } from "../services/settings/SettingsService";
import { useAuthStore } from "../store/authStore";
import { useToast } from "../hooks/useToast";
import { friendlyErrorMessage } from "../utils/errors";
import { ComingSoon } from "../components/ComingSoon";
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
  { id: "projects", label: "Projects", icon: <FolderKanban size={16} />, accent: "#0f766e", tint: "rgba(15, 118, 110, .1)" },
  { id: "shared", label: "Shared", icon: <Link2 size={16} />, accent: "#db2777", tint: "rgba(236, 72, 153, .1)" },
  { id: "transcribed", label: "Transcribed", icon: <FileText size={16} />, accent: "#b45309", tint: "rgba(245, 158, 11, .13)" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const SHARED_TABS = [
  { id: "mine", label: "Shared by you" },
  { id: "team", label: "Shared with your team" },
] as const;
type SharedTabId = (typeof SHARED_TABS)[number]["id"];


const SECTION_IDS = SECTIONS.map((s) => s.id) as readonly string[];

export function LibraryPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [section, setSection] = useState<SectionId>(() => {
    const requested = searchParams.get("section");
    return requested && SECTION_IDS.includes(requested) ? (requested as SectionId) : "videos";
  });
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [errorFor, setErrorFor] = useState<{ id: string; message: string } | null>(null);
  const toast = useToast();
  const stoppedRef = useRef(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [sharedTab, setSharedTab] = useState<SharedTabId>("mine");
  const [folderError, setFolderError] = useState<{ id: string; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Video | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const session = useAuthStore((s) => s.session);
  // Same gating as the Meeting tab's model picker (see MeetingPage.tsx's cloudEnabled) —
  // only offer the hosted Doculigent option to accounts on a paid plan.
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

  const sectionVideos =
    section === "transcribed"
      ? videos.filter((v) => v.transcript)
      : section === "meeting"
        ? videos.filter((v) => v.source === "meeting")
        : videos.filter((v) => v.source === "record");
  const viewingVideo = videos.find((v) => v.id === viewingId) ?? null;

  useEffect(() => {
    if (!viewingId) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setViewingId(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewingId]);

  const [retranscribeLanguage, setRetranscribeLanguage] = useState(DEFAULT_TRANSCRIPTION_LANGUAGE);
  const [retranscribeModel, setRetranscribeModel] = useState<WhisperModelSize | null>(null);
  // Which BYOK (transcribe-capable) model, configured in Settings, this re-transcribe
  // should use instead of a local Whisper size — null means "use the local size below"
  // rather than one of the profiles from llmProfiles. Not persisted anywhere (unlike the
  // Meeting tab's global BYOK selection); it only applies to the next transcribe click.
  const [retranscribeByokId, setRetranscribeByokId] = useState<string | null>(null);
  // Whether the picker below is set to the hosted Doculigent option rather than a local
  // size or BYOK profile — same "not implemented yet" status as the Meeting tab's cloud
  // option (see MeetingPage.tsx's useDoculigent), so selecting it here just disables the
  // (Re-)transcribe button below instead of firing a request nothing can serve yet.
  const [retranscribeUseCloud, setRetranscribeUseCloud] = useState(false);
  const [modelStatuses, setModelStatuses] = useState<WhisperModelStatus[] | null>(null);
  useEffect(() => {
    SettingsService.getWhisperModel().then(setRetranscribeModel).catch(() => {});
    SettingsService.getWhisperModelStatuses().then(setModelStatuses).catch(() => {});
  }, []);
  // Excludes anything still mid-download: the model cache writes its files incrementally,
  // so `downloaded` (any bytes on disk) can go true before a download actually finishes
  // (see whisper.ts's requireDownloadedModel for the same check on the main-process side).
  const downloadedModels = WHISPER_MODELS.filter((m) => {
    const status = modelStatuses?.find((s) => s.size === m.size);
    return status?.downloaded && !status.downloading;
  });
  // Falls back to whichever downloaded size sorts first when no model is active in
  // Settings — the picker below only ever lists downloaded sizes, so this is never used
  // to silently trigger a download.
  const effectiveRetranscribeModel = retranscribeModel ?? downloadedModels[0]?.size;

  // Custom/BYOK profiles tagged "transcribe" in Settings > Models — offered alongside the
  // downloaded local sizes so re-transcribing isn't limited to on-device Whisper.
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

  async function handleTranscribeClick(v: Video) {
    setViewingId(v.id);
    if (v.transcript) return;
    // No model set up at all yet — opening the drawer is enough; its model picker already
    // shows the "no models configured" hint + Settings link and disables Transcribe, so
    // don't also fire a transcribe attempt that can only fail (see whisper.ts's
    // requireDownloadedModel — it refuses rather than silently downloading one).
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
    if (section === "transcribed") {
      setVideoTranscript.mutate({ id: v.id, transcript: null });
    } else {
      setDeleteTarget(v);
    }
  }

  function confirmDelete(keepFile: boolean) {
    if (!deleteTarget) return;
    deleteVideo.mutate({ id: deleteTarget.id, keepFile });
    setDeleteTarget(null);
  }

  function confirmBulkDelete(keepFile: boolean) {
    if (sectionVideos.length === 0) return;
    deleteVideos.mutate({ ids: sectionVideos.map((v) => v.id), keepFile });
    setBulkDeleteOpen(false);
  }

  const activeSection = SECTIONS.find((s) => s.id === section)!;
  const canBulkDelete = section === "videos" || section === "meeting";

  return (
    <div className="library-layout">
      <div className="library-body">
        <nav className="library-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === section ? "library-nav-item active" : "library-nav-item"}
              style={{ "--nav-accent": s.accent, "--nav-tint": s.tint } as CSSProperties}
              onClick={() => setSection(s.id)}
            >
              <span className="library-nav-icon">{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>

        <section
          className="panel library-list-panel"
          style={{ "--section-accent": activeSection.accent, "--section-tint": activeSection.tint } as CSSProperties}
        >
          {section === "shared" ? (
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
                      : "Your team's shared recordings will show up here once doculigent.com sharing is live."}
                  </p>
                ) : (
                  <p className="muted">
                    Sign in with doculigent.com to see shared recordings — <Link to="/account">go to Account</Link>.
                  </p>
                )}
              </div>
            </>
          ) : section === "projects" ? (
            <ComingSoon
              icon={<FolderKanban size={36} />}
              title="Projects is coming soon"
            />
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
              </div>

              <div className="library-toolbar">
                <input
                  type="search"
                  placeholder="Search titles & transcripts…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {canBulkDelete && (
                  <button
                    type="button"
                    className="danger library-delete-all"
                    disabled={sectionVideos.length === 0}
                    onClick={() => setBulkDeleteOpen(true)}
                  >
                    Delete All
                  </button>
                )}
              </div>

              {isLoading && <p className="muted">Loading…</p>}
              {!isLoading && sectionVideos.length === 0 && (
                <p className="muted">
                  {section === "transcribed"
                    ? "No transcribed recordings yet — tap the transcribe icon on a recording."
                    : section === "meeting"
                      ? "No meetings recorded yet — head to the Meeting tab."
                      : "No recordings yet — head to the Record tab."}
                </p>
              )}

              <div className="library-grid">
                {sectionVideos.map((v) => (
                  <div key={v.id} className="video-card">
                    <div className="thumb">
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
                          {/* Sharing requires a doculigent.com account and is a Phase 2
                              feature (see prompt.md's roadmap) — intentionally a no-op. */}
                          <button type="button" title="Share" className="icon-btn icon-btn-share" onClick={() => {}}>
                            <Link2 size={20} />
                          </button>
                          <button
                            type="button"
                            title={section === "transcribed" ? "Delete transcript" : "Delete recording"}
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

      {bulkDeleteOpen && (
        <div className="modal-backdrop" onClick={() => setBulkDeleteOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              Delete all {sectionVideos.length} {sectionVideos.length === 1 ? "recording" : "recordings"}?
            </h2>
            <p className="muted">
              You can clear every recording from your library and keep the files on disk, or delete both the
              library entries and the files themselves. This can't be undone.
            </p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setBulkDeleteOpen(false)}>
                Cancel
              </button>
              <button type="button" onClick={() => confirmBulkDelete(true)}>
                Delete All from Library
              </button>
              <button type="button" className="danger" onClick={() => confirmBulkDelete(false)}>
                Delete All from Disk
              </button>
            </div>
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
