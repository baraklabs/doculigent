import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Settings, X, Plus, Trash2, Pencil, PanelLeftClose, PanelLeftOpen, FileText, Video, Mic } from "lucide-react";
import type { ChatMessage, Transcript, TranscriptSegment } from "@shared/types/models";
import { DEFAULT_TRANSCRIPTION_LANGUAGE, TRANSCRIPTION_LANGUAGES } from "@shared/constants/languages";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";
import { WHISPER_MODELS } from "@shared/constants/whisperModels";
import { isBilledTier } from "@shared/constants/plans";
import { useVideo, useVideos, useSetVideoTranscript } from "../hooks/useVideos";
import { useLlmProfiles } from "../hooks/useLlmProfiles";
import { TranscriptionService } from "../services/transcription/TranscriptionService";
import { SettingsService } from "../services/settings/SettingsService";
import { AiService } from "../services/ai/AiService";
import { useAuthStore } from "../store/authStore";
import { ChatMessageContent } from "../components/ChatMessageContent";
import "./AiPage.css";

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Remembers the last model picked here across tab switches (this page unmounts when you
// navigate away, wiping its React state) and app reloads — plain localStorage rather than
// the settings store since this is a per-renderer UI preference, not app configuration.
const LAST_PROFILE_KEY = "aiAssistant.lastProfileId";
const SIDEBAR_COLLAPSED_KEY = "aiAssistant.sidebarCollapsed";
const SESSIONS_KEY = "aiAssistant.chatSessions";

// Canned questions for the Summarize/Generate Notes quick actions — sent through the
// normal ask() pipeline rather than AiService.summarize()'s separate structured-JSON
// endpoint, since the transcript already grounds a plain chat reply just as well and this
// way the result renders as a normal (markdown, copyable) assistant message in the log.
const SUMMARIZE_PROMPT = "Summarize this recording in a few concise paragraphs, covering the key points.";
const NOTES_PROMPT =
  "Generate structured notes from this recording, organized with headings and bullet points.";

interface ChatSession {
  id: string;
  title: string;
  // Set once the user manually renames a session — persistSession then leaves the title
  // alone on later messages instead of overwriting it with a fresh deriveTitle() each time.
  titleCustom?: boolean;
  messages: ChatMessage[];
  videoId: string;
  profileId: string;
  updatedAt: string; // ISO
}

function loadSessions(): ChatSession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    return raw ? (JSON.parse(raw) as ChatSession[]) : [];
  } catch {
    return [];
  }
}

function saveSessions(sessions: ChatSession[]): void {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

// A session's sidebar label is just its opening question — good enough to recognize at a
// glance without asking the model to summarize its own conversation.
function deriveTitle(messages: ChatMessage[]): string {
  const text = messages.find((m) => m.role === "user")?.content.trim() || "New chat";
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

/**
 * Chatbot-style hub: the conversation fills the page, with the model and an optional
 * attached recording/meeting chosen from a settings popup rather than always-visible
 * dropdowns — unlike AiPage (reached from a specific video, two-column transcript+chat
 * layout), this doesn't require navigating from a video first and reads like a normal
 * chat app. Attaching a transcribed recording grounds answers in it, but it's never
 * required — chatting works with just a model (see ask()'s null transcript fallback).
 *
 * Past conversations are saved to a collapsible sidebar (New chat / Recent chats, à la
 * ChatGPT/Claude) — see ChatSession above and the sessions/activeSessionId state below.
 * Sessions are only ever written to localStorage, never sent anywhere, matching this app's
 * local-first stance elsewhere (e.g. the model-selection persistence above).
 */
export function AiAssistantPage() {
  const { data: videos = [] } = useVideos("");
  const { data: profiles = [] } = useLlmProfiles();
  const session = useAuthStore((s) => s.session);
  // Same gating as the Meeting tab's model picker (see MeetingPage.tsx's cloudEnabled) —
  // only offer the hosted Doculigent option to accounts on a paid plan.
  const cloudEnabled = !!session?.user.plan && isBilledTier(session.user.plan.tier);

  // The Library tab's per-card AI icon, and the Meeting tab's post-save "Summarize/
  // Generate Notes/Quick Chat" quick actions, navigate here with the recording/meeting
  // passed via router state (see LibraryPage.tsx and MeetingPage.tsx's
  // navigate("/ai", { state: { videoId, action } })) — read once on mount so landing here
  // fresh already has that attachment set, same as if it had been picked from the settings
  // popup by hand. `action`, if present, auto-fires Summarize/Generate Notes once that
  // attachment's transcript has loaded (see the effect below) rather than requiring the
  // user to click the quick-action buttons again after arriving.
  const location = useLocation();
  const initialNavState = location.state as { videoId?: string; action?: "summarize" | "notes" } | null;
  const [videoId, setVideoId] = useState(() => initialNavState?.videoId ?? "");
  const [pendingAction, setPendingAction] = useState(() => initialNavState?.action ?? null);
  const { data: video } = useVideo(videoId || undefined);
  const [profileOverride, setProfileOverride] = useState(() => localStorage.getItem(LAST_PROFILE_KEY) ?? "");
  // Same "not implemented yet" hosted option as the Meeting/Library/transcribe pickers
  // (see MeetingPage.tsx's useDoculigent) — a sentinel value in profileOverride rather
  // than a separate flag, since this picker only ever has one selection at a time anyway.
  const usingCloudChat = profileOverride === "doculigent" && cloudEnabled;
  const profileId = profileOverride && !usingCloudChat ? profileOverride : undefined;
  const selectedProfile = profiles.find((p) => p.id === profileId);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Persists the choice as it's made, and drops it if it ever stops resolving to a real
  // profile (deleted in Settings, or the localStorage value was stale on first load) so
  // the picker doesn't sit on a phantom selection nothing can actually use.
  useEffect(() => {
    if (!profileOverride) return;
    if (profileOverride === "doculigent") {
      if (cloudEnabled) {
        localStorage.setItem(LAST_PROFILE_KEY, profileOverride);
      } else {
        setProfileOverride("");
        localStorage.removeItem(LAST_PROFILE_KEY);
      }
      return;
    }
    if (profiles.length === 0) return; // still loading — don't judge it yet
    if (profiles.some((p) => p.id === profileOverride)) {
      localStorage.setItem(LAST_PROFILE_KEY, profileOverride);
    } else {
      setProfileOverride("");
      localStorage.removeItem(LAST_PROFILE_KEY);
    }
  }, [profileOverride, profiles, cloudEnabled]);

  const [transcript, setTranscript] = useState<Transcript | null>(null);

  // Whether the "Transcribed" status pill has collapsed down to just its green check (see
  // the resource card below) — starts open so a fresh attachment's status is readable, then
  // collapses itself after a beat. Resets to open (and re-collapses) whenever the
  // attachment or its transcribed-ness changes, so switching to a different transcribed
  // video re-announces it instead of silently staying collapsed.
  const [transcribedBadgeCollapsed, setTranscribedBadgeCollapsed] = useState(false);
  useEffect(() => {
    if (!transcript) {
      setTranscribedBadgeCollapsed(false);
      return;
    }
    setTranscribedBadgeCollapsed(false);
    const timer = setTimeout(() => setTranscribedBadgeCollapsed(true), 1400);
    return () => clearTimeout(timer);
  }, [transcript, video?.id]);

  // Whether the sticky resource card (see below) is expanded to show its transcribe
  // controls — toggled by clicking the card itself. Same underlying language/model pickers
  // and inline segment editing + Save as the Library tab's transcript drawer, just inline
  // in this card instead of a separate modal.
  const [resourceExpanded, setResourceExpanded] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [drawerLanguage, setDrawerLanguage] = useState(DEFAULT_TRANSCRIPTION_LANGUAGE);
  const [drawerModel, setDrawerModel] = useState<WhisperModelSize | null>(null);
  const [drawerByokId, setDrawerByokId] = useState<string | null>(null);
  // Whether the picker below is set to the hosted Doculigent option rather than a local
  // size or BYOK profile — same "not implemented yet" status as the Meeting tab's cloud
  // option (see MeetingPage.tsx's useDoculigent), so selecting it here just disables the
  // (Re-)transcribe button below instead of firing a request nothing can serve yet.
  const [drawerUseCloud, setDrawerUseCloud] = useState(false);
  const [modelStatuses, setModelStatuses] = useState<WhisperModelStatus[] | null>(null);
  useEffect(() => {
    SettingsService.getWhisperModel().then(setDrawerModel).catch(() => {});
    SettingsService.getWhisperModelStatuses().then(setModelStatuses).catch(() => {});
  }, []);
  // Excludes anything still mid-download — same check as Library/Meeting's model pickers
  // (see modelCache.ts's incremental-write caveat).
  const downloadedModels = WHISPER_MODELS.filter((m) => {
    const status = modelStatuses?.find((s) => s.size === m.size);
    return status?.downloaded && !status.downloading;
  });
  const effectiveDrawerModel = drawerModel ?? downloadedModels[0]?.size;
  // Transcribe-capable profiles from the same Settings > Models list used for chat above.
  const byokProfiles = profiles.filter((p) => p.capabilities.includes("transcribe"));
  const usingDrawerByok = drawerByokId !== null && byokProfiles.some((p) => p.id === drawerByokId);
  const usingDrawerCloud = drawerUseCloud && cloudEnabled;
  const hasAnyTranscribeModel = downloadedModels.length > 0 || byokProfiles.length > 0 || cloudEnabled;

  function handleDrawerModelSelectChange(value: string) {
    if (value === "doculigent") {
      setDrawerUseCloud(true);
      setDrawerByokId(null);
    } else if (value.startsWith("byok:")) {
      setDrawerUseCloud(false);
      setDrawerByokId(value.slice("byok:".length));
    } else {
      setDrawerUseCloud(false);
      setDrawerByokId(null);
      setDrawerModel(value as WhisperModelSize);
    }
  }

  const setVideoTranscript = useSetVideoTranscript();
  const [editingSegments, setEditingSegments] = useState<TranscriptSegment[] | null>(null);
  const [savingEdits, setSavingEdits] = useState(false);
  // Keeps the drawer's editable copy in sync with whichever attachment/transcript is
  // current whenever it's open — same pattern as Library's transcript drawer.
  useEffect(() => {
    if (!resourceExpanded) return;
    setEditingSegments(transcript?.segments ?? null);
  }, [resourceExpanded, transcript]);
  const isEditingDirty =
    !!editingSegments &&
    !!transcript &&
    JSON.stringify(editingSegments.map((s) => s.text)) !== JSON.stringify(transcript.segments.map((s) => s.text));

  function updateSegmentText(index: number, text: string) {
    setEditingSegments((segs) => segs?.map((s, i) => (i === index ? { ...s, text } : s)) ?? segs);
  }

  function cancelSegmentEdits() {
    setEditingSegments(transcript?.segments ?? null);
  }

  async function saveSegmentEdits() {
    if (!editingSegments || !transcript || !video) return;
    setSavingEdits(true);
    try {
      const next = { ...transcript, segments: editingSegments };
      await setVideoTranscript.mutateAsync({ id: video.id, transcript: next });
      setTranscript(next);
    } finally {
      setSavingEdits(false);
    }
  }

  async function runVideoTranscribe() {
    if (!video) return;
    setTranscribing(true);
    setTranscribeError(null);
    try {
      const byokId = usingDrawerByok ? (drawerByokId ?? undefined) : undefined;
      const next = await TranscriptionService.transcribe(
        video.filePath,
        drawerLanguage,
        byokId ? undefined : effectiveDrawerModel,
        byokId
      );
      await setVideoTranscript.mutateAsync({ id: video.id, transcript: next });
      setTranscript(next);
    } catch (e) {
      setTranscribeError(String(e));
    } finally {
      setTranscribing(false);
    }
  }

  async function stopVideoTranscribe() {
    await TranscriptionService.cancel();
  }

  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
  const sortedSessions = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Which session's sidebar entry is showing its inline rename input right now, if any.
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  // Keeps the attached video's transcript in sync whenever the attachment changes — for
  // any reason (picked in the settings popup, restored from a loaded session). Clearing
  // the conversation itself on an attachment change is a separate, deliberate action (see
  // handleAttachmentChange) rather than living here, so restoring a session's own video
  // doesn't wipe the history that session just loaded.
  useEffect(() => {
    setTranscript(video?.transcript ?? null);
  }, [video?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function newChat() {
    setActiveSessionId(null);
    setVideoId("");
    setHistory([]);
    setQuestion("");
    setError(null);
  }

  function openSession(session: ChatSession) {
    if (session.id === activeSessionId) return;
    setActiveSessionId(session.id);
    setHistory(session.messages);
    setVideoId(session.videoId);
    if (session.profileId) setProfileOverride(session.profileId);
    setQuestion("");
    setError(null);
  }

  function deleteSession(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveSessions(next);
      return next;
    });
    if (id === activeSessionId) newChat();
  }

  function startRename(session: ChatSession, e: React.MouseEvent) {
    e.stopPropagation();
    setRenamingSessionId(session.id);
    setRenameDraft(session.title);
  }

  function commitRename(id: string) {
    setRenamingSessionId(null);
    const title = renameDraft.trim();
    if (!title) return;
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === id ? { ...s, title, titleCustom: true } : s));
      saveSessions(next);
      return next;
    });
  }

  // Attaching for the first time onto an already-in-progress (unattached) chat continues
  // that same conversation/session — only swapping away from an *existing* attachment is a
  // deliberate context switch that starts a fresh, unsaved conversation (like "New chat"),
  // since the messages so far were grounded in that old attachment. In practice the
  // settings popup's Attachment select is disabled once history exists for a chat that
  // already has one (see its `disabled` prop), so this reset branch is mostly a safety net
  // rather than something reachable mid-conversation.
  function handleAttachmentChange(id: string) {
    const hadAttachment = !!videoId;
    setVideoId(id);
    if (hadAttachment) {
      setActiveSessionId(null);
      setHistory([]);
      setQuestion("");
      setError(null);
    }
  }

  function persistSession(messages: ChatMessage[]) {
    const id = activeSessionId ?? crypto.randomUUID();
    if (!activeSessionId) setActiveSessionId(id);
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      const existing = idx >= 0 ? prev[idx] : null;
      // A manually-renamed title (see commitRename) sticks — otherwise every subsequent
      // message in the session would silently overwrite it back to the opening question.
      const session: ChatSession = {
        id,
        title: existing?.titleCustom ? existing.title : deriveTitle(messages),
        titleCustom: existing?.titleCustom,
        messages,
        videoId,
        profileId: profileOverride,
        updatedAt: new Date().toISOString(),
      };
      const next = idx >= 0 ? prev.map((s, i) => (i === idx ? session : s)) : [session, ...prev];
      saveSessions(next);
      return next;
    });
  }

  // `presetQuestion` lets the Summarize/Generate Notes quick actions (see
  // chat-quick-actions below) send a canned question through the exact same pipeline as
  // anything typed by hand, instead of a separate one-off summarize code path — the
  // transcript already grounds the reply via the chat system prompt (see
  // openAiCompatibleClient.ts), so a well-worded question does the same job.
  // `transcriptOverride`: the pendingAction auto-fire effect below needs to pass the
  // just-loaded video's transcript explicitly rather than relying on the `transcript`
  // state variable — that state is set by a separate effect keyed on video?.id, and on the
  // very render where `video` first loads, that effect's setTranscript call hasn't
  // propagated into this render's `transcript` closure yet, which would otherwise send the
  // auto-fired question ungrounded (null transcript) even though one is actually available.
  async function ask(presetQuestion?: string, transcriptOverride?: Transcript | null) {
    const q = (presetQuestion ?? question).trim();
    if (!q || chatBusy) return;
    const next: ChatMessage[] = [...history, { role: "user", content: q }];
    setHistory(next);
    if (!presetQuestion) setQuestion("");
    setChatBusy(true);
    setError(null);
    try {
      // transcript is null when nothing's attached (or it hasn't been transcribed yet) —
      // AiService.chat/the backend fall back to a plain assistant prompt in that case, so
      // chatting only ever needs a model, not an attachment (see openAiCompatibleClient.ts).
      const t = transcriptOverride !== undefined ? transcriptOverride : transcript;
      const reply = await AiService.chat(t, next, q, profileId);
      const final = [...next, reply];
      setHistory(final);
      persistSession(final);
    } catch (e) {
      setError(String(e));
    } finally {
      setChatBusy(false);
    }
  }

  // Fires the Summarize/Generate Notes action carried over from MeetingPage.tsx's
  // post-save quick actions (see pendingAction above) — waits for `video` to actually
  // load (the attachment was just set by id, not fetched yet) rather than firing
  // immediately with a stale/empty transcript, and reads video.transcript directly (see
  // ask()'s transcriptOverride) rather than the separately-synced `transcript` state to
  // avoid a one-render race. If the video turns out to have no transcript (no speech
  // detected during the meeting), it's silently dropped rather than asking a question with
  // nothing to ground it — the normal composer is still right there.
  useEffect(() => {
    if (!pendingAction || !video) return;
    setPendingAction(null);
    if (video.transcript) ask(pendingAction === "summarize" ? SUMMARIZE_PROMPT : NOTES_PROMPT, video.transcript);
  }, [pendingAction, video]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="chat-page-shell">
      <aside className={sidebarCollapsed ? "chat-sidebar collapsed" : "chat-sidebar"}>
        <div className="chat-sidebar-top">
          <button
            type="button"
            className="icon-btn"
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed((c) => !c)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          {!sidebarCollapsed && <span className="chat-sidebar-title">Chats</span>}
        </div>

        <button type="button" className="chat-sidebar-new" title="New chat" onClick={newChat}>
          <Plus size={16} />
          {!sidebarCollapsed && <span>New chat</span>}
        </button>

        {!sidebarCollapsed && (
          <div className="chat-sidebar-list">
            {sortedSessions.length === 0 && <p className="muted chat-sidebar-empty">No chats yet</p>}
            {sortedSessions.map((s) =>
              renamingSessionId === s.id ? (
                <div key={s.id} className="chat-sidebar-item chat-sidebar-item-renaming">
                  <input
                    className="chat-sidebar-item-rename-input"
                    value={renameDraft}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(s.id);
                      if (e.key === "Escape") setRenamingSessionId(null);
                    }}
                  />
                </div>
              ) : (
                <div
                  key={s.id}
                  className={s.id === activeSessionId ? "chat-sidebar-item active" : "chat-sidebar-item"}
                  onClick={() => openSession(s)}
                >
                  <span className="chat-sidebar-item-title">{s.title}</span>
                  <button
                    type="button"
                    className="chat-sidebar-item-rename"
                    title="Rename chat"
                    onClick={(e) => startRename(s, e)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="chat-sidebar-item-delete"
                    title="Delete chat"
                    onClick={(e) => deleteSession(s.id, e)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              )
            )}
          </div>
        )}
      </aside>

      <div className="chat-page">
        {/* .chat-page-log is the scroll container and spans the full column width, so its
            scrollbar sits at the actual right edge of the page rather than hugging the
            centered .chat-page-log-inner content — otherwise the scrollbar would float in
            the middle of the page next to the narrower message column. */}
        <div className="chat-page-log">
          <div className="chat-page-log-inner">
            {!video && history.length === 0 && (
              <div className="chat-page-empty">
                <p className="muted">Ask anything, or attach a recording below to ask about it specifically.</p>
                {videos.length === 0 && (
                  <p className="muted">No recordings yet — head to the Record tab.</p>
                )}
              </div>
            )}

            {video && !transcript && !transcribing && history.length === 0 && (
              <div className="chat-page-empty">
                <p className="muted">
                  Transcribe this attachment to ask about it specifically — or just ask anything below.
                </p>
              </div>
            )}

            {history.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                <ChatMessageContent content={m.content} />
                {m.citations?.map((c, j) => (
                  <button key={j} className="citation" title={c.quote}>
                    ↷ {fmt(c.timestamp)}
                  </button>
                ))}
              </div>
            ))}

            {error && <p className="error">{error}</p>}
          </div>
        </div>

        <div className="chat-page-composer">
          {/* Only for a transcribed attachment on a fresh conversation — once you've
              started chatting (or there's nothing grounding these prompts) they'd just be
              clutter, same reasoning as the chat-page-empty hints above. */}
          {transcript && history.length === 0 && (
            <div className="chat-quick-actions">
              <button type="button" onClick={() => ask(SUMMARIZE_PROMPT)} disabled={chatBusy}>
                Summarize
              </button>
              <button type="button" onClick={() => ask(NOTES_PROMPT)} disabled={chatBusy}>
                Generate Notes
              </button>
            </div>
          )}

          <div className="chat-input">
            <button
              type="button"
              className="icon-btn"
              title="Model & attachment settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={18} />
            </button>
            <input
              value={question}
              disabled={chatBusy}
              placeholder={transcript ? "Ask about this attachment…" : "Ask anything…"}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ask()}
            />
            <button onClick={() => ask()} disabled={chatBusy || !question.trim()}>
              {chatBusy ? "…" : "Ask"}
            </button>
          </div>

          <p className="chat-page-meta muted">
            Model: {usingCloudChat ? "Doculigent (cloud)" : (selectedProfile?.name ?? "none")} · Attachment: {video?.title ?? "none"}
          </p>
        </div>

        {settingsOpen && (
          <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="transcript-drawer-header">
                <h2>Model & attachment</h2>
                <button type="button" className="icon-btn" title="Close" onClick={() => setSettingsOpen(false)}>
                  <X size={20} />
                </button>
              </div>

              <label className="field">
                <span>Model</span>
                <select
                  value={profileOverride}
                  onChange={(e) => setProfileOverride(e.target.value)}
                  disabled={profiles.length === 0 && !cloudEnabled}
                >
                  {profiles.length === 0 && !cloudEnabled && <option value="">No models configured</option>}
                  {(profiles.length > 0 || cloudEnabled) && <option value="">Select a model…</option>}
                  {cloudEnabled && <option value="doculigent">Doculigent (cloud)</option>}
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {profiles.length === 0 && !cloudEnabled && (
                  <small className="field-hint">
                    <Link to="/settings">Add a model in Settings</Link>
                  </small>
                )}
              </label>

              <label className="field">
                <span>Attachment</span>
                <select
                  value={videoId}
                  onChange={(e) => handleAttachmentChange(e.target.value)}
                  disabled={!!videoId && history.length > 0}
                >
                  <option value="">+ Add attachment…</option>
                  {videos.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title}
                    </option>
                  ))}
                </select>
                {/* Only once something's actually attached — attaching one for the first
                    time mid-chat is still fine, it's swapping/removing an existing
                    attachment mid-conversation that would silently discard history (see
                    handleAttachmentChange) that's locked here. */}
                {!!videoId && history.length > 0 && (
                  <small className="field-hint">Start a new chat to change the attachment.</small>
                )}
              </label>

              <div className="actions modal-actions">
                <button type="button" className="primary" onClick={() => setSettingsOpen(false)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Sticky card for the attached video — pinned to the right edge of the app
            (position: fixed, see AiPage.css) rather than living inline in the scrollable
            log, so it stays reachable no matter how far you've scrolled the conversation.
            Slides/fades in on mount and whenever the attachment changes (see
            .chat-resource-card's animation). Clicking it toggles resourceExpanded, which
            reveals the same Transcribe/Re-transcribe controls and inline segment editing +
            Save as the Library tab's transcript drawer, just inline here instead of a
            separate modal. */}
        {video &&
          (() => {
            // Shared by the outer card (shrinks its own box, not just its content — see
            // .chat-resource-card.collapsed) and the inner summary/status pill, so all
            // three collapse and re-expand in lockstep. Expanding (resourceExpanded) always
            // wins over the auto-collapse timer — clicking the tiny collapsed badge should
            // bring the title back too, not just reveal the drawer below an empty box.
            const badgeCollapsed = !!transcript && transcribedBadgeCollapsed && !resourceExpanded;
            return (
              <div
                key={video.id}
                className={
                  resourceExpanded
                    ? "chat-resource-card expanded"
                    : badgeCollapsed
                      ? "chat-resource-card collapsed"
                      : "chat-resource-card"
                }
                onClick={() => setResourceExpanded((v) => !v)}
              >
                <div className={badgeCollapsed ? "chat-resource-summary collapsed" : "chat-resource-summary"}>
                  <span className="chat-resource-icon">
                    {video.source === "meeting" ? <Mic size={16} /> : <Video size={16} />}
                  </span>
                  <span className="chat-resource-title">{video.title}</span>
                  {transcript ? (
                    // Opens full (icon + title + "Transcribed" + icon) on load/attachment-
                    // change, then the whole summary row collapses down to just the green
                    // transcribe icon after a beat (see badgeCollapsed above).
                    <span className={badgeCollapsed ? "chat-transcribe-status ok collapsed" : "chat-transcribe-status ok"}>
                      <span className="chat-transcribe-status-text">Transcribed</span>
                      <FileText size={14} />
                    </span>
              ) : (
                // Stays open (never collapses) — it's a call to action, not a status.
                <span className="chat-transcribe-status warn">Transcribe to get insights</span>
              )}
            </div>

            {resourceExpanded && (
              <div className="chat-resource-expanded" onClick={(e) => e.stopPropagation()}>
                <fieldset className="field retranscribe-controls" disabled={transcribing}>
                  <legend>Transcribe with</legend>

                  <div className="retranscribe-row">
                    <label className="field">
                      <span>Language</span>
                      <select value={drawerLanguage} onChange={(e) => setDrawerLanguage(e.target.value)}>
                        {TRANSCRIPTION_LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field">
                      <span>Model</span>
                      {hasAnyTranscribeModel ? (
                        <select
                          value={usingDrawerCloud ? "doculigent" : usingDrawerByok ? `byok:${drawerByokId}` : (effectiveDrawerModel ?? "")}
                          onChange={(e) => handleDrawerModelSelectChange(e.target.value)}
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

                {/* Deliberately outside the fieldset above — its `disabled` while
                    transcribing is meant to lock the language/model pickers, not the Stop
                    button, which needs to stay clickable for exactly that duration. */}
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={runVideoTranscribe}
                    disabled={transcribing || !hasAnyTranscribeModel}
                  >
                    {transcribing ? "Transcribing…" : transcript ? "Re-transcribe" : "Transcribe"}
                  </button>
                  {transcribing && (
                    <button type="button" className="danger" onClick={stopVideoTranscribe}>
                      Stop
                    </button>
                  )}
                </div>

                {transcribeError && <p className="error">{transcribeError}</p>}

                {editingSegments && editingSegments.length > 0 && (
                  <>
                    <div className="transcript-drawer-header">
                      <h3>Transcript</h3>
                      <div className="actions">
                        {isEditingDirty && (
                          <button type="button" onClick={cancelSegmentEdits} disabled={savingEdits}>
                            Cancel
                          </button>
                        )}
                        <button
                          type="button"
                          className="primary"
                          onClick={saveSegmentEdits}
                          disabled={savingEdits || !isEditingDirty}
                        >
                          {savingEdits ? "Saving…" : "Save"}
                        </button>
                      </div>
                    </div>

                    <div className="segments">
                      {editingSegments.map((seg, i) => (
                        <div key={i} className="segment">
                          <span className="ts">{fmt(seg.start)}</span>
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

                {!transcript && !transcribing && !transcribeError && <p className="muted">No transcript yet.</p>}
              </div>
            )}
              </div>
            );
          })()}
      </div>
    </div>
  );
}
