import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Link } from "react-router-dom";
import type { TranscriptSegment, Video } from "@shared/types/models";
import { mediaUrl } from "@shared/constants/media";
import { DEFAULT_TRANSCRIPTION_LANGUAGE, TRANSCRIPTION_LANGUAGES } from "@shared/constants/languages";
import { DEFAULT_WHISPER_MODEL, WHISPER_MODELS } from "@shared/constants/whisperModels";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";
import { useDeleteVideo, useRenameVideo, useSetVideoTranscript, useVideos } from "../hooks/useVideos";
import { TranscriptionService } from "../services/transcription/TranscriptionService";
import { SettingsService } from "../services/settings/SettingsService";
import { useAuthStore } from "../store/authStore";

/** Just the filename for the folder icon's hover tooltip — the full path is what
 *  actually gets revealed, but the filename alone is what's useful to read at a glance. */
function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Nudges a freshly-loaded <video> to a non-zero frame so it renders as a real thumbnail
 *  instead of a black/blank first frame. */
function showThumbnailFrame(e: SyntheticEvent<HTMLVideoElement>): void {
  const video = e.currentTarget;
  video.currentTime = Math.min(0.1, video.duration || 0);
}

const SECTIONS = [
  { id: "videos", label: "Videos" },
  { id: "meeting", label: "Meeting" },
  { id: "shared", label: "Shared" },
  { id: "transcribed", label: "Transcribed" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const SHARED_TABS = [
  { id: "mine", label: "Shared by you" },
  { id: "team", label: "Shared with your team" },
] as const;
type SharedTabId = (typeof SHARED_TABS)[number]["id"];

/**
 * The recording library. Side nav: Videos (Record tab captures), Meeting (Meeting tab's
 * audio recordings — see MeetingPage for actually making one), Shared, and Transcribed
 * (cross-cutting — any recording with a saved transcript, regardless of source).
 */
export function LibraryPage() {
  const [section, setSection] = useState<SectionId>("videos");
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [errorFor, setErrorFor] = useState<{ id: string; message: string } | null>(null);
  // Set right before a user-initiated Stop, so runTranscribe's catch block can tell "the
  // worker died because the user stopped it" apart from a genuine transcription failure.
  const stoppedRef = useRef(false);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [sharedTab, setSharedTab] = useState<SharedTabId>("mine");
  const [folderError, setFolderError] = useState<{ id: string; message: string } | null>(null);
  const session = useAuthStore((s) => s.session);

  /** Reveals a specific recording's file in the OS file explorer, selected — not just the
   *  save folder in general, so it works the same for videos, meeting audio, and
   *  transcribed recordings (the transcript itself has no separate file to reveal, just
   *  the recording it's attached to). */
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

  // Re-transcribe controls in the drawer — language/model default to the app-wide
  // Settings > Transcription choice (model fetched once on mount) but only apply to this
  // one re-transcription, not the global setting. The model picker only ever offers
  // already-downloaded sizes (modelStatuses, below) — picking an undownloaded size here
  // would silently kick off a multi-hundred-MB download in the middle of what looks like
  // a quick re-transcribe; downloading stays a Settings > Transcription-only action.
  const [retranscribeLanguage, setRetranscribeLanguage] = useState(DEFAULT_TRANSCRIPTION_LANGUAGE);
  const [retranscribeModel, setRetranscribeModel] = useState<WhisperModelSize>(DEFAULT_WHISPER_MODEL);
  const [modelStatuses, setModelStatuses] = useState<WhisperModelStatus[] | null>(null);
  useEffect(() => {
    SettingsService.getWhisperModel().then(setRetranscribeModel).catch(() => {});
    SettingsService.getWhisperModelStatuses().then(setModelStatuses).catch(() => {});
  }, []);
  const downloadedModels = WHISPER_MODELS.filter((m) => modelStatuses?.find((s) => s.size === m.size)?.downloaded);

  // Editable copy of the currently-viewed transcript's segments. Resyncs from the
  // persisted transcript whenever the drawer opens (viewingId flips, including
  // closing and reopening the *same* video — that must discard any unsaved edits from
  // last time, not leave them lingering) or a (re)transcribe finishes.
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

  /** Discards unsaved edits, reverting the drawer back to the last-saved transcript
   *  without closing it. */
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

  async function runTranscribe(v: Video, language?: string, modelSize?: WhisperModelSize) {
    setTranscribingId(v.id);
    setErrorFor(null);
    stoppedRef.current = false;
    try {
      const transcript = await TranscriptionService.transcribe(v.filePath, language, modelSize);
      await setVideoTranscript.mutateAsync({ id: v.id, transcript });
    } catch (e) {
      // A user-initiated Stop kills the transcription worker outright (there's no
      // mid-inference abort signal — see whisperWorkerClient.ts's terminateTranscriptionWorker),
      // which surfaces here as this same call rejecting. Show that as a deliberate stop,
      // not a scary failure.
      if (!stoppedRef.current) setErrorFor({ id: v.id, message: String(e) });
    } finally {
      setTranscribingId(null);
    }
  }

  /** Stops whichever transcription is currently running — there's no per-chunk cancel, so
   *  this kills the worker process outright (see TranscriptionService.cancel); the next
   *  transcribe/re-transcribe call transparently re-forks a fresh one. */
  async function handleStopTranscribe() {
    stoppedRef.current = true;
    await TranscriptionService.cancel();
  }

  /** Opens the transcript drawer on the right; transcribes first if this recording doesn't
   *  have one yet (the drawer picks up the result once it's persisted and re-fetched). */
  async function handleTranscribeClick(v: Video) {
    setViewingId(v.id);
    if (v.transcript) return;
    await runTranscribe(v);
  }

  /** The drawer's own "Re-transcribe" button — unlike the card icon's first-time
   *  transcribe, this always uses whatever language/model are currently picked in the
   *  drawer, and runs even if a transcript already exists. */
  function handleRetranscribeClick(v: Video) {
    return runTranscribe(v, retranscribeLanguage, retranscribeModel);
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

  /** In the Transcribed section, the trash icon clears just the transcript (so the
   *  recording drops back out of this list) — it only deletes the whole recording from
   *  the Videos/Meeting sections. */
  function handleDelete(v: Video) {
    if (section === "transcribed") {
      setVideoTranscript.mutate({ id: v.id, transcript: null });
    } else {
      deleteVideo.mutate(v.id);
    }
  }

  return (
    <div className="library-layout">
      <div className="library-body">
        <nav className="library-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === section ? "library-nav-item active" : "library-nav-item"}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <section className="panel library-list-panel">
          {section === "shared" ? (
            <>
              <h1>Shared</h1>
              <p className="muted">Recordings shared through your doculigent.com account.</p>

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
                      ? "Nothing shared yet. Sharing (the 🔗 icon on a recording) is still being built for doculigent.com accounts."
                      : "Your team's shared recordings will show up here once doculigent.com sharing is live."}
                  </p>
                ) : (
                  <p className="muted">
                    Sign in with doculigent.com to see shared recordings — <Link to="/account">go to Account</Link>.
                  </p>
                )}
              </div>
            </>
          ) : (
            <>
              <h1>{SECTIONS.find((s) => s.id === section)?.label}</h1>
              <p className="muted">
                {section === "meeting" ? "Audio recorded from the Meeting tab." : "Every recording, stored locally."}
              </p>

              <div className="library-toolbar">
                <input
                  type="search"
                  placeholder="Search titles & transcripts…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
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
                        <div className="thumb-audio">🎙️</div>
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
                            ✓
                          </button>
                          <button
                            type="button"
                            title="Cancel"
                            className="icon-btn icon-btn-cancel"
                            onClick={() => setRenamingId(null)}
                          >
                            ✕
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
                            📁
                          </button>
                          <button
                            type="button"
                            title={v.transcript ? "Re-transcribe" : "Transcribe"}
                            className="icon-btn icon-btn-transcribe"
                            disabled={transcribingId === v.id}
                            onClick={() => handleTranscribeClick(v)}
                          >
                            {transcribingId === v.id ? "…" : "📄"}
                          </button>
                          <button
                            type="button"
                            title="Rename"
                            className="icon-btn icon-btn-rename"
                            onClick={() => startRename(v)}
                          >
                            ✎︎
                          </button>
                          {/* Sharing requires a doculigent.com account and is a Phase 2
                              feature (see prompt.md's roadmap) — intentionally a no-op. */}
                          <button type="button" title="Share" className="icon-btn icon-btn-share" onClick={() => {}}>
                            🔗
                          </button>
                          <button
                            type="button"
                            title={section === "transcribed" ? "Delete transcript" : "Delete recording"}
                            className="icon-btn icon-btn-delete"
                            onClick={() => handleDelete(v)}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>

                    {errorFor?.id === v.id && <p className="error video-card-error">{errorFor.message}</p>}
                    {folderError?.id === v.id && <p className="error video-card-error">{folderError.message}</p>}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {viewingVideo && (
        <div className="transcript-drawer-backdrop" onClick={() => setViewingId(null)}>
          <aside className="transcript-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="transcript-drawer-header">
              <h2>{viewingVideo.title}</h2>
              <button type="button" className="icon-btn" title="Close (Esc)" onClick={() => setViewingId(null)}>
                ✕
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
                  {downloadedModels.length > 0 ? (
                    <select
                      value={retranscribeModel}
                      onChange={(e) => setRetranscribeModel(e.target.value as WhisperModelSize)}
                    >
                      {downloadedModels.map((m) => (
                        <option key={m.size} value={m.size}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    modelStatuses && (
                      <span className="muted field-hint-inline">
                        No models downloaded — get one in <Link to="/settings">Settings &gt; Transcription</Link>.
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
                disabled={transcribingId === viewingVideo.id || downloadedModels.length === 0}
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
