import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Settings,
  X,
  Plus,
  Trash2,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Mic,
  Video,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import type { ChatMessage, Transcript, TranscriptSegment } from "@shared/types/models";
import { mediaUrl } from "@shared/constants/media";
import { DEFAULT_TRANSCRIPTION_LANGUAGE, TRANSCRIPTION_LANGUAGES } from "@shared/constants/languages";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";
import { WHISPER_MODELS } from "@shared/constants/whisperModels";
import { isBilledTier } from "@shared/constants/plans";
import { useVideo, useVideos, useSetVideoTranscript } from "../hooks/useVideos";
import { useLlmProfiles } from "../hooks/useLlmProfiles";
import {
  useAppIntegrations,
  useGithubCommentIssue,
  useGithubCreateIssue,
  useSlackPostMessage,
} from "../hooks/useAppIntegrations";
import { appProviderMeta } from "../providers/apps";
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

// Plain-text rendition of a transcript for the Actions block's "Transcript" content
// option — a GitHub issue body/Slack message has no use for the structured Transcript
// shape, just readable lines.
function transcriptToPlainText(transcript: Transcript): string {
  return transcript.segments.map((s) => `[${fmt(s.start)}] ${s.speaker}: ${s.text}`).join("\n");
}

// Remembers the last model picked here across tab switches (this page unmounts when you
// navigate away, wiping its React state) and app reloads — plain localStorage rather than
// the settings store since this is a per-renderer UI preference, not app configuration.
const LAST_PROFILE_KEY = "aiAssistant.lastProfileId";
const SIDEBAR_COLLAPSED_KEY = "aiAssistant.sidebarCollapsed";
const VIDEO_PANEL_OPEN_KEY = "aiAssistant.videoPanelOpen";
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

interface VideoInsights {
  summary?: string;
  notes?: string;
}

// Keyed per-video (not per-session) since the same recording's summary/notes should show
// up again however it's reattached — a different chat session, or just navigating back to
// this page — rather than only surviving as long as the videoPanelTab stays mounted.
function videoInsightsKey(videoId: string): string {
  return `aiAssistant.videoInsights.${videoId}`;
}

function loadVideoInsights(videoId: string): VideoInsights {
  try {
    const raw = localStorage.getItem(videoInsightsKey(videoId));
    return raw ? (JSON.parse(raw) as VideoInsights) : {};
  } catch {
    return {};
  }
}

function saveVideoInsights(videoId: string, insights: VideoInsights): void {
  localStorage.setItem(videoInsightsKey(videoId), JSON.stringify(insights));
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
  // Only chat-capable profiles belong in the Ask-chat model picker below — a profile saved
  // purely for transcription (no "chat" capability) can't actually answer questions, so
  // listing it there would just be a selectable option that fails immediately.
  const chatProfiles = profiles.filter((p) => p.capabilities.includes("chat"));
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
  const selectedProfile = chatProfiles.find((p) => p.id === profileId);
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
    if (chatProfiles.some((p) => p.id === profileOverride)) {
      localStorage.setItem(LAST_PROFILE_KEY, profileOverride);
    } else {
      setProfileOverride("");
      localStorage.removeItem(LAST_PROFILE_KEY);
    }
  }, [profileOverride, profiles, chatProfiles, cloudEnabled]);

  const [transcript, setTranscript] = useState<Transcript | null>(null);

  // Docked video/audio detail panel (see chat-video-panel below) — opened by the
  // Summarize/Generate Notes quick actions, the "Transcribe to get insights" prompt, or
  // the toggle button next to the composer, and squeezes the chat column rather than
  // floating over it. Stays mounted (width animates 0 → open) so its video/audio element
  // and tab state survive being hidden. Open/closed is a persisted UI preference (same
  // pattern as sidebarCollapsed) rather than attachment-specific state — switching
  // attachments only resets which tab/text is showing (see the video?.id effect below),
  // not whether the panel itself is open.
  const [videoPanelOpen, setVideoPanelOpen] = useState(() => localStorage.getItem(VIDEO_PANEL_OPEN_KEY) === "1");
  useEffect(() => {
    localStorage.setItem(VIDEO_PANEL_OPEN_KEY, videoPanelOpen ? "1" : "0");
  }, [videoPanelOpen]);
  const [videoPanelTab, setVideoPanelTab] = useState<"summary" | "notes" | "transcribe">("summary");
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [notesText, setNotesText] = useState<string | null>(null);
  // Which quick action is currently in flight, if any — lets the panel show "Summarizing…"
  // in only the tab that's actually running rather than both (runQuickAction guards against
  // starting a second one while this is set).
  const [runningAction, setRunningAction] = useState<"summarize" | "notes" | null>(null);
  // Separate from the main chat `error` below — a failed Summarize/Generate Notes shouldn't
  // show up under the chat log it never touched, only in the panel itself.
  const [panelError, setPanelError] = useState<string | null>(null);

  // Actions block (bottom of the panel) — lets the user send the Summary/Notes/Transcript
  // to one of their connected Settings > Apps integrations. Only one action form expands
  // at a time; its field state resets whenever a different integration/action is opened
  // (see openActionForm) rather than being tracked per-action, since only one is ever
  // visible.
  const { data: integrations = [] } = useAppIntegrations();
  const githubCreateIssueMutation = useGithubCreateIssue();
  const githubCommentIssueMutation = useGithubCommentIssue();
  const slackPostMessageMutation = useSlackPostMessage();
  // Whether the Actions sheet is expanded — collapsed by default (just the toggle bar) so
  // it doesn't eat into the Summary/Notes/Transcribe content above. A normal flex sibling
  // of .chat-video-panel-inner (see AiPage.css), so expanding it squeezes that content
  // upward rather than overlaying/covering it.
  const [actionsExpanded, setActionsExpanded] = useState(false);
  const [openAction, setOpenAction] = useState<{
    integrationId: string;
    kind: "githubCreateIssue" | "githubCommentIssue" | "slackPostMessage";
  } | null>(null);
  // Deliberately starts at null (not defaulted to the active videoPanelTab) — the user
  // picks a content source explicitly every time an action form opens, rather than it being
  // silently inferred, so it's always clear exactly what's about to be sent externally.
  const [actionSource, setActionSource] = useState<"summary" | "notes" | "transcript" | null>(null);
  const [actionRepo, setActionRepo] = useState("");
  const [actionTitle, setActionTitle] = useState("");
  const [actionIssueNumber, setActionIssueNumber] = useState("");
  const [actionChannel, setActionChannel] = useState("");
  const [actionResult, setActionResult] = useState<{ ok: boolean; message: string; url?: string } | null>(null);
  const actionSending =
    githubCreateIssueMutation.isPending || githubCommentIssueMutation.isPending || slackPostMessageMutation.isPending;

  function openActionForm(
    integrationId: string,
    kind: "githubCreateIssue" | "githubCommentIssue" | "slackPostMessage"
  ) {
    setOpenAction({ integrationId, kind });
    setActionSource(null);
    setActionRepo("");
    setActionTitle(video?.title ?? "");
    setActionIssueNumber("");
    setActionChannel("");
    setActionResult(null);
  }

  function resolveActionContent(source: "summary" | "notes" | "transcript" | null): string | null {
    if (source === "summary") return summaryText;
    if (source === "notes") return notesText;
    if (source === "transcript") return transcript ? transcriptToPlainText(transcript) : null;
    return null;
  }

  const actionContent = resolveActionContent(actionSource);
  const actionFieldsValid = (() => {
    if (!openAction || !actionContent) return false;
    if (openAction.kind === "githubCreateIssue") return actionRepo.trim().includes("/");
    if (openAction.kind === "githubCommentIssue") return actionRepo.trim().includes("/") && !!actionIssueNumber.trim();
    return !!actionChannel.trim(); // slackPostMessage
  })();

  async function runOpenAction() {
    if (!openAction || !actionContent || !actionFieldsValid) return;
    setActionResult(null);
    try {
      if (openAction.kind === "githubCreateIssue") {
        setActionResult(
          await githubCreateIssueMutation.mutateAsync({
            integrationId: openAction.integrationId,
            repo: actionRepo.trim(),
            title: actionTitle.trim() || video?.title || "Doculigent recording",
            body: actionContent,
          })
        );
      } else if (openAction.kind === "githubCommentIssue") {
        setActionResult(
          await githubCommentIssueMutation.mutateAsync({
            integrationId: openAction.integrationId,
            repo: actionRepo.trim(),
            issueNumber: Number(actionIssueNumber),
            body: actionContent,
          })
        );
      } else {
        setActionResult(
          await slackPostMessageMutation.mutateAsync({
            integrationId: openAction.integrationId,
            channel: actionChannel.trim(),
            text: actionContent,
          })
        );
      }
    } catch (e) {
      setActionResult({ ok: false, message: String(e) });
    }
  }

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
  // Keeps the drawer's editable copy in sync whenever the transcript itself changes (new
  // attachment, or a (re-)transcribe/save completes) — same pattern as Library's transcript
  // drawer. Re-syncing after saveSegmentEdits is a no-op (the new transcript's segments
  // already equal editingSegments), so this never clobbers an in-progress edit.
  useEffect(() => {
    setEditingSegments(transcript?.segments ?? null);
  }, [transcript]);
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

  // Summary/Notes are per-attachment, cached in localStorage (see loadVideoInsights) so
  // they survive navigating away and back, not just component state — switching
  // attachments restores whatever was already generated for the new one (if any) rather
  // than always dropping to empty. Whether the panel itself is open is a separate,
  // persisted preference (see videoPanelOpen above) and isn't touched here.
  useEffect(() => {
    const cached = video ? loadVideoInsights(video.id) : {};
    setSummaryText(cached.summary ?? null);
    setNotesText(cached.notes ?? null);
    setVideoPanelTab("summary");
    setOpenAction(null);
    setActionsExpanded(false);
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

  // Only ever sends what the user actually typed and hit Ask/Enter on — Summarize/
  // Generate Notes are a deliberately separate path (see runQuickAction below) that never
  // touches history/persistSession, so the visible conversation only ever contains
  // questions the user actually asked, not canned prompts fired on their behalf.
  async function ask() {
    const q = question.trim();
    if (!q || chatBusy) return;
    const next: ChatMessage[] = [...history, { role: "user", content: q, timestamp: new Date().toISOString() }];
    setHistory(next);
    setQuestion("");
    setChatBusy(true);
    setError(null);
    try {
      // transcript is null when nothing's attached (or it hasn't been transcribed yet) —
      // AiService.chat/the backend fall back to a plain assistant prompt in that case, so
      // chatting only ever needs a model, not an attachment (see openAiCompatibleClient.ts).
      const reply = await AiService.chat(transcript, next, q, profileId);
      // The backend doesn't set a timestamp (see ChatMessage's comment) — stamped here,
      // right when the reply actually lands, rather than left undefined.
      const final = [...next, { ...reply, timestamp: new Date().toISOString() }];
      setHistory(final);
      persistSession(final);
    } catch (e) {
      setError(String(e));
    } finally {
      setChatBusy(false);
    }
  }

  // Summarize/Generate Notes — deliberately bypasses ask()/history/persistSession so
  // clicking these never adds a canned prompt+reply into the visible conversation or a
  // saved session; the reply only ever lands in the panel's Summary/Notes tab (and gets
  // cached per-video via saveVideoInsights so it survives navigating away and back).
  // `transcriptOverride` is for the pendingAction auto-fire effect below, which needs the
  // just-loaded video's transcript directly rather than the separately-synced `transcript`
  // state (see that effect's comment for why relying on `transcript` would race).
  async function runQuickAction(action: "summarize" | "notes", transcriptOverride?: Transcript | null) {
    const t = transcriptOverride !== undefined ? transcriptOverride : transcript;
    if (!t || runningAction) return;
    setVideoPanelTab(action === "summarize" ? "summary" : "notes");
    setVideoPanelOpen(true);
    setRunningAction(action);
    setPanelError(null);
    try {
      const prompt = action === "summarize" ? SUMMARIZE_PROMPT : NOTES_PROMPT;
      const reply = await AiService.chat(t, [], prompt, profileId);
      if (action === "summarize") setSummaryText(reply.content);
      else setNotesText(reply.content);
      if (video) {
        const cached = loadVideoInsights(video.id);
        saveVideoInsights(video.id, { ...cached, [action === "summarize" ? "summary" : "notes"]: reply.content });
      }
    } catch (e) {
      setPanelError(String(e));
    } finally {
      setRunningAction(null);
    }
  }

  // Fires the Summarize/Generate Notes action carried over from MeetingPage.tsx's
  // post-save quick actions (see pendingAction above) — waits for `video` to actually
  // load (the attachment was just set by id, not fetched yet) rather than firing
  // immediately with a stale/empty transcript, and reads video.transcript directly (see
  // runQuickAction's transcriptOverride) rather than the separately-synced `transcript`
  // state to avoid a one-render race. If the video turns out to have no transcript (no
  // speech detected during the meeting), it's silently dropped rather than summarizing
  // with nothing to ground it.
  useEffect(() => {
    if (!pendingAction || !video) return;
    setPendingAction(null);
    if (video.transcript) runQuickAction(pendingAction, video.transcript);
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
                <ChatMessageContent content={m.content} timestamp={m.timestamp} />
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
          {/* Attached but not transcribed yet — a call to action rather than a status, so
              it's shown regardless of conversation length (unlike the quick actions below).
              Opens the docked panel to the Transcribe tab and, if a model's actually
              configured, fires the transcribe right away instead of making the user click
              Transcribe again once the panel slides in. */}
          {video && !transcript && (
            <button
              type="button"
              className="chat-transcribe-warning"
              onClick={() => {
                setVideoPanelTab("transcribe");
                setVideoPanelOpen(true);
                if (hasAnyTranscribeModel && !transcribing) runVideoTranscribe();
              }}
            >
              <span className="chat-transcribe-warning-icon">
                {video.source === "meeting" ? <Mic size={14} /> : <Video size={14} />}
              </span>
              <span className="chat-transcribe-warning-title">{video.title}</span>
              <span className="chat-transcribe-warning-cta">Transcribe to get insights</span>
            </button>
          )}

          {/* Only for a transcribed attachment on a fresh conversation — once you've
              started chatting (or there's nothing grounding these prompts) they'd just be
              clutter, same reasoning as the chat-page-empty hints above. */}
          {transcript && history.length === 0 && (
            <div className="chat-quick-actions">
              <button type="button" onClick={() => runQuickAction("summarize")} disabled={runningAction !== null}>
                Summarize
              </button>
              <button type="button" onClick={() => runQuickAction("notes")} disabled={runningAction !== null}>
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
                  disabled={chatProfiles.length === 0 && !cloudEnabled}
                >
                  {chatProfiles.length === 0 && !cloudEnabled && <option value="">No models configured</option>}
                  {(chatProfiles.length > 0 || cloudEnabled) && <option value="">Select a model…</option>}
                  {cloudEnabled && <option value="doculigent">Doculigent (cloud)</option>}
                  {chatProfiles.map((p) => (
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

      </div>

      {/* Docked video/audio detail panel — a direct sibling of .chat-page (not nested
          inside it), squeezing the chat column instead of floating over it or stacking
          below the composer. Collapses to a slim rail (same pattern as .chat-sidebar)
          rather than fully disappearing, so its toggle icon stays reachable in the same
          top-right spot whether open or closed — no separate open button needed
          elsewhere. `wide` gives it more room once the left chat-sidebar is collapsed,
          instead of leaving that freed-up width unused. Opened by the Summarize/Generate
          Notes quick actions (runQuickAction), the "Transcribe to get insights" prompt
          above the composer, or this toggle. */}
      {video && (
        <aside
          className={
            videoPanelOpen ? `chat-video-panel open${sidebarCollapsed ? " wide" : ""}` : "chat-video-panel"
          }
        >
          <div className="chat-video-panel-top">
            <button
              type="button"
              className="icon-btn"
              title={videoPanelOpen ? "Hide recording panel" : "Show recording panel"}
              onClick={() => setVideoPanelOpen((v) => !v)}
            >
              {videoPanelOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
            </button>
            {videoPanelOpen && <span className="chat-video-panel-title">{video.title}</span>}
          </div>

          {videoPanelOpen && (
          <>
          <div className="chat-video-panel-inner">
            <div className="chat-video-preview">
              {video.source === "meeting" ? (
                <audio src={mediaUrl(video.filePath)} controls preload="metadata" />
              ) : (
                <video src={mediaUrl(video.filePath)} controls preload="metadata" />
              )}
            </div>

            <div className="chat-video-panel-tabs">
              <button
                type="button"
                className={videoPanelTab === "summary" ? "chat-video-tab active" : "chat-video-tab"}
                onClick={() => setVideoPanelTab("summary")}
              >
                Summary
              </button>
              <button
                type="button"
                className={videoPanelTab === "notes" ? "chat-video-tab active" : "chat-video-tab"}
                onClick={() => setVideoPanelTab("notes")}
              >
                Notes
              </button>
              <button
                type="button"
                className={videoPanelTab === "transcribe" ? "chat-video-tab active" : "chat-video-tab"}
                onClick={() => setVideoPanelTab("transcribe")}
              >
                Transcribe
              </button>
            </div>

            <div className="chat-video-panel-body">
              {videoPanelTab === "summary" && (
                <>
                  {summaryText ? (
                    <div className="chat-video-panel-text">
                      <ChatMessageContent content={summaryText} />
                    </div>
                  ) : (
                    <p className="muted">
                      {runningAction === "summarize"
                        ? "Summarizing…"
                        : transcript
                          ? "No summary yet."
                          : "Transcribe this recording first to summarize it."}
                    </p>
                  )}
                  {transcript && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => runQuickAction("summarize")}
                      disabled={runningAction !== null}
                    >
                      {runningAction === "summarize" ? "…" : summaryText ? "Regenerate" : "Summarize"}
                    </button>
                  )}
                  {panelError && videoPanelTab === "summary" && <p className="error">{panelError}</p>}
                </>
              )}

              {videoPanelTab === "notes" && (
                <>
                  {notesText ? (
                    <div className="chat-video-panel-text">
                      <ChatMessageContent content={notesText} />
                    </div>
                  ) : (
                    <p className="muted">
                      {runningAction === "notes"
                        ? "Generating notes…"
                        : transcript
                          ? "No notes yet."
                          : "Transcribe this recording first to generate notes."}
                    </p>
                  )}
                  {transcript && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => runQuickAction("notes")}
                      disabled={runningAction !== null}
                    >
                      {runningAction === "notes" ? "…" : notesText ? "Regenerate" : "Generate Notes"}
                    </button>
                  )}
                  {panelError && videoPanelTab === "notes" && <p className="error">{panelError}</p>}
                </>
              )}

              {videoPanelTab === "transcribe" && (
                <>
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
                      transcribing is meant to lock the language/model pickers, not the
                      Stop button, which needs to stay clickable for exactly that
                      duration. */}
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
                </>
              )}
            </div>

          </div>

          {/* Actions sheet — collapsed to just its toggle bar by default. A normal flex
              sibling of .chat-video-panel-inner (not absolutely positioned/overlaid), so
              expanding it squeezes that content upward — .chat-video-panel-inner's own
              flex:1/overflow-y:auto shrinks and keeps everything (Summary/Notes/Transcribe,
              including the Regenerate button) reachable by scrolling within the smaller
              space, rather than an overlay covering it. Lists every app connected in
              Settings > Apps with its available action(s); clicking one expands an inline
              form right there (content source + whatever that action needs). */}
          {video && (
            <div className={actionsExpanded ? "chat-actions-sheet open" : "chat-actions-sheet"}>
              <button
                type="button"
                className="chat-actions-toggle"
                onClick={() => setActionsExpanded((v) => !v)}
              >
                <span>Actions</span>
                {actionsExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
              {actionsExpanded && (
              <div className="chat-actions-sheet-body">
              {integrations.length === 0 ? (
                <p className="muted">
                  No apps connected — <Link to="/settings">connect one in Settings</Link>.
                </p>
              ) : (
                <div className="chat-actions-list">
                  {integrations.map((integ) => {
                    const meta = appProviderMeta(integ.kind);
                    return (
                      <div key={integ.id} className="chat-action-app">
                        <div className="chat-action-app-header">
                          <span
                            className={meta.multicolor ? "app-icon multicolor" : "app-icon"}
                            style={meta.multicolor ? undefined : { background: meta.accent }}
                          >
                            {meta.icon}
                          </span>
                          <span className="chat-action-app-name">{integ.name}</span>
                        </div>

                        <div className="chat-action-buttons">
                          {integ.kind === "github" && (
                            <>
                              <button type="button" onClick={() => openActionForm(integ.id, "githubCreateIssue")}>
                                Create Issue
                              </button>
                              <button type="button" onClick={() => openActionForm(integ.id, "githubCommentIssue")}>
                                Comment
                              </button>
                            </>
                          )}
                          {integ.kind === "slack" && (
                            <button type="button" onClick={() => openActionForm(integ.id, "slackPostMessage")}>
                              Post Message
                            </button>
                          )}
                        </div>

                        {openAction?.integrationId === integ.id && (
                          <div className="chat-action-form">
                            <div className="chat-action-source-picker">
                              <span className="muted">Send</span>
                              <button
                                type="button"
                                className={actionSource === "summary" ? "chip active" : "chip"}
                                disabled={!summaryText}
                                onClick={() => setActionSource("summary")}
                              >
                                Summary
                              </button>
                              <button
                                type="button"
                                className={actionSource === "notes" ? "chip active" : "chip"}
                                disabled={!notesText}
                                onClick={() => setActionSource("notes")}
                              >
                                Notes
                              </button>
                              <button
                                type="button"
                                className={actionSource === "transcript" ? "chip active" : "chip"}
                                disabled={!transcript}
                                onClick={() => setActionSource("transcript")}
                              >
                                Transcript
                              </button>
                            </div>

                            {openAction.kind === "githubCreateIssue" && (
                              <>
                                <input
                                  value={actionRepo}
                                  placeholder="owner/repo"
                                  onChange={(e) => setActionRepo(e.target.value)}
                                />
                                <input
                                  value={actionTitle}
                                  placeholder="Issue title"
                                  onChange={(e) => setActionTitle(e.target.value)}
                                />
                              </>
                            )}
                            {openAction.kind === "githubCommentIssue" && (
                              <>
                                <input
                                  value={actionRepo}
                                  placeholder="owner/repo"
                                  onChange={(e) => setActionRepo(e.target.value)}
                                />
                                <input
                                  value={actionIssueNumber}
                                  placeholder="Issue or PR #"
                                  inputMode="numeric"
                                  onChange={(e) => setActionIssueNumber(e.target.value.replace(/\D/g, ""))}
                                />
                              </>
                            )}
                            {openAction.kind === "slackPostMessage" && (
                              <input
                                value={actionChannel}
                                placeholder="#channel or channel ID"
                                onChange={(e) => setActionChannel(e.target.value)}
                              />
                            )}

                            <div className="actions">
                              <button
                                type="button"
                                className="primary"
                                onClick={runOpenAction}
                                disabled={!actionFieldsValid || actionSending}
                              >
                                {actionSending ? "Sending…" : "Send"}
                              </button>
                              <button type="button" onClick={() => setOpenAction(null)}>
                                Cancel
                              </button>
                            </div>

                            {actionResult && (
                              <p className={actionResult.ok ? "muted" : "error"}>
                                {actionResult.message}
                                {actionResult.url && (
                                  <>
                                    {" "}
                                    <button
                                      type="button"
                                      className="link-btn"
                                      onClick={() => window.open(actionResult.url, "_blank")}
                                    >
                                      View
                                    </button>
                                  </>
                                )}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
              )}
            </div>
          )}
          </>
          )}
        </aside>
      )}
    </div>
  );
}
