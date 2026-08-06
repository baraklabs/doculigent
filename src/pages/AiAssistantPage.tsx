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
  Bot,
  Info,
  UserCog,
} from "lucide-react";
import type { ChatMessage, Transcript, TranscriptSegment } from "@shared/types/models";
import type { PmPersonaId } from "@shared/types/projectManager";
import { PM_PERSONAS, listAllPersonas, resolvePersonaById } from "@shared/constants/pmPersonas";
import { mediaUrl } from "@shared/constants/media";
import { DEFAULT_TRANSCRIPTION_LANGUAGE, TRANSCRIPTION_LANGUAGES } from "@shared/constants/languages";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";
import { WHISPER_MODELS } from "@shared/constants/whisperModels";
import { isBilledTier } from "@shared/constants/plans";
import { useVideo, useVideos, useSetVideoTranscript } from "../hooks/useVideos";
import { useLlmProfiles } from "../hooks/useLlmProfiles";
import { useTeams } from "../hooks/useTeams";
import { useProjectManagers, useSaveProjectManager } from "../hooks/useProjectManagers";
import { useCustomPersonas } from "../hooks/useCustomPersonas";
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
import { ProjectManagerPanel } from "../components/ProjectManagerPanel";
import { PersonaManagerPanel } from "../components/PersonaManagerPanel";
import "./AiPage.css";

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function transcriptToPlainText(transcript: Transcript): string {
  return transcript.segments.map((s) => `[${fmt(s.start)}] ${s.speaker}: ${s.text}`).join("\n");
}

const LAST_PROFILE_KEY = "aiAssistant.lastProfileId";
const SIDEBAR_COLLAPSED_KEY = "aiAssistant.sidebarCollapsed";
const VIDEO_PANEL_OPEN_KEY = "aiAssistant.videoPanelOpen";
const SESSIONS_KEY = "aiAssistant.chatSessions";

const SUMMARIZE_PROMPT = "Summarize this recording in a few concise paragraphs, covering the key points.";
const NOTES_PROMPT =
  "Generate structured notes from this recording, organized with headings and bullet points.";

interface ChatSession {
  id: string;
  title: string;
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

function deriveTitle(messages: ChatMessage[]): string {
  const text = messages.find((m) => m.role === "user")?.content.trim() || "New chat";
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}


export function AiAssistantPage() {
  const { data: videos = [] } = useVideos("");
  const { data: profiles = [] } = useLlmProfiles();
  const chatProfiles = profiles.filter((p) => p.capabilities.includes("chat"));
  const session = useAuthStore((s) => s.session);
  const cloudEnabled = !!session?.user.plan && isBilledTier(session.user.plan.tier);

  const location = useLocation();
  const initialNavState = location.state as { videoId?: string; action?: "summarize" | "notes" } | null;
  const [videoId, setVideoId] = useState(() => initialNavState?.videoId ?? "");
  const [pendingAction, setPendingAction] = useState(() => initialNavState?.action ?? null);
  const { data: video } = useVideo(videoId || undefined);
  const [profileOverride, setProfileOverride] = useState(() => localStorage.getItem(LAST_PROFILE_KEY) ?? "");
  const usingCloudChat = profileOverride === "doculigent" && cloudEnabled;
  const profileId = profileOverride && !usingCloudChat ? profileOverride : undefined;
  const selectedProfile = chatProfiles.find((p) => p.id === profileId);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const [videoPanelOpen, setVideoPanelOpen] = useState(() => localStorage.getItem(VIDEO_PANEL_OPEN_KEY) === "1");
  useEffect(() => {
    localStorage.setItem(VIDEO_PANEL_OPEN_KEY, videoPanelOpen ? "1" : "0");
  }, [videoPanelOpen]);
  const [videoPanelTab, setVideoPanelTab] = useState<"summary" | "notes" | "transcribe">("summary");
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [notesText, setNotesText] = useState<string | null>(null);
  const [runningAction, setRunningAction] = useState<"summarize" | "notes" | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  const { data: integrations = [] } = useAppIntegrations();
  const githubCreateIssueMutation = useGithubCreateIssue();
  const githubCommentIssueMutation = useGithubCommentIssue();
  const slackPostMessageMutation = useSlackPostMessage();
  const [actionsExpanded, setActionsExpanded] = useState(false);
  const [openAction, setOpenAction] = useState<{
    integrationId: string;
    kind: "githubCreateIssue" | "githubCommentIssue" | "slackPostMessage";
  } | null>(null);
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
    return !!actionChannel.trim(); 
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
  const [drawerUseCloud, setDrawerUseCloud] = useState(false);
  const [modelStatuses, setModelStatuses] = useState<WhisperModelStatus[] | null>(null);
  useEffect(() => {
    SettingsService.getWhisperModel().then(setDrawerModel).catch(() => {});
    SettingsService.getWhisperModelStatuses().then(setModelStatuses).catch(() => {});
  }, []);
  const downloadedModels = WHISPER_MODELS.filter((m) => {
    const status = modelStatuses?.find((s) => s.size === m.size);
    return status?.downloaded && !status.downloading;
  });
  const effectiveDrawerModel = drawerModel ?? downloadedModels[0]?.size;
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

  const { data: projectManagers = [] } = useProjectManagers();
  const { data: customPersonas = [] } = useCustomPersonas();
  const { data: teams = [] } = useTeams();
  const saveProjectManager = useSaveProjectManager();
  const [activePmId, setActivePmId] = useState<string | null>(null);
  const activePm = projectManagers.find((pm) => pm.id === activePmId) ?? null;
  const [showPersonaManager, setShowPersonaManager] = useState(false);
  const [addPmOpen, setAddPmOpen] = useState(false);
  const [newPmName, setNewPmName] = useState("");
  const [newPmPersona, setNewPmPersona] = useState<PmPersonaId>(PM_PERSONAS[0].id);
  const [newPmTeamId, setNewPmTeamId] = useState("");
  const [newPmChatProfileId, setNewPmChatProfileId] = useState("");
  const [newPmTranscribeModel, setNewPmTranscribeModel] = useState("");
  const [creatingPm, setCreatingPm] = useState(false);
  const pmTranscribeOptions = [
    ...downloadedModels.map((m) => ({ value: m.size as string, label: m.label })),
    ...byokProfiles.map((p) => ({ value: `byok:${p.id}`, label: p.name || "BYOK" })),
  ];
  const newPmEffectiveFocus = resolvePersonaById(newPmPersona, customPersonas).focus;

  function openAddPm() {
    setNewPmName("");
    setNewPmPersona(PM_PERSONAS[0].id);
    setNewPmTeamId(teams[0]?.id ?? "");
    setNewPmChatProfileId(chatProfiles[0]?.id ?? "");
    setNewPmTranscribeModel(pmTranscribeOptions[0]?.value ?? "");
    setAddPmOpen(true);
  }

  async function createProjectManager() {
    const team = teams.find((t) => t.id === newPmTeamId);
    if (!team || !newPmName.trim() || creatingPm) return;
    setCreatingPm(true);
    try {
      const created = await saveProjectManager.mutateAsync({
        id: "",
        name: newPmName.trim(),
        teamId: team.id,
        teamName: team.name,
        persona: newPmPersona,
        triggerMode: "manual",
        scheduleTime: null,
        actions: {},
        insights: [],
        chatProfileId: newPmChatProfileId || null,
        transcribeModel: newPmTranscribeModel || null,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
      });
      setAddPmOpen(false);
      setActivePmId(created.id);
    } finally {
      setCreatingPm(false);
    }
  }
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? "1" : "0");
  }, [sidebarCollapsed]);

  useEffect(() => {
    setTranscript(video?.transcript ?? null);
  }, [video?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const cached = video ? loadVideoInsights(video.id) : {};
    setSummaryText(cached.summary ?? null);
    setNotesText(cached.notes ?? null);
    setVideoPanelTab("summary");
    setOpenAction(null);
    setActionsExpanded(false);
  }, [video?.id]); 

  function newChat() {
    setActivePmId(null);
    setShowPersonaManager(false);
    setActiveSessionId(null);
    setVideoId("");
    setHistory([]);
    setQuestion("");
    setError(null);
  }

  function openSession(session: ChatSession) {
    setActivePmId(null);
    setShowPersonaManager(false);
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

  async function ask() {
    const q = question.trim();
    if (!q || chatBusy) return;
    const next: ChatMessage[] = [...history, { role: "user", content: q, timestamp: new Date().toISOString() }];
    setHistory(next);
    setQuestion("");
    setChatBusy(true);
    setError(null);
    try {
      const reply = await AiService.chat(transcript, next, q, profileId);
      const final = [...next, { ...reply, timestamp: new Date().toISOString() }];
      setHistory(final);
      persistSession(final);
    } catch (e) {
      setError(String(e));
    } finally {
      setChatBusy(false);
    }
  }

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

  useEffect(() => {
    if (!pendingAction || !video) return;
    setPendingAction(null);
    if (video.transcript) runQuickAction(pendingAction, video.transcript);
  }, [pendingAction, video]); 

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

        {!sidebarCollapsed && <div className="chat-sidebar-divider" />}

        {!sidebarCollapsed && (
          <div className="chat-sidebar-section-header">
            <div className="pm-sidebar-title-group">
              <span className="chat-sidebar-section-title">Project Managers</span>
              <button
                type="button"
                className="pm-sidebar-add"
                title="Manage personas"
                onClick={() => {
                  setActivePmId(null);
                  setShowPersonaManager(true);
                }}
              >
                <UserCog size={14} />
              </button>
            </div>
            <button type="button" className="pm-sidebar-add" title="Add AI Project Manager" onClick={openAddPm}>
              <Plus size={15} />
            </button>
          </div>
        )}
        {sidebarCollapsed && (
          <button type="button" className="chat-sidebar-new" title="Add AI Project Manager" onClick={openAddPm}>
            <Bot size={16} />
          </button>
        )}

        {/* A second, independently-scrolling list — deliberately not merged with the Chats
            list above (each has its own overflow-y:auto and shares the sidebar's remaining
            height via flex:1), so scrolling through project managers never scrolls chats
            out of view and vice versa. */}
        {!sidebarCollapsed && (
          <div className="chat-sidebar-list">
            {projectManagers.length === 0 && <p className="muted chat-sidebar-empty">No project managers yet</p>}
            {projectManagers.map((pm) => (
              <div
                key={pm.id}
                className={pm.id === activePmId ? "chat-sidebar-item active" : "chat-sidebar-item"}
                onClick={() => {
                  setShowPersonaManager(false);
                  setActivePmId(pm.id);
                }}
              >
                <span className="chat-sidebar-item-title">
                  {pm.name}
                  <span className="pm-sidebar-item-persona"> · {resolvePersonaById(pm.persona, customPersonas).name}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </aside>

      {showPersonaManager ? (
        <div className="chat-page">
          <PersonaManagerPanel />
        </div>
      ) : activePm ? (
        <div className="chat-page">
          <ProjectManagerPanel
            pm={activePm}
            onDeleted={() => setActivePmId(null)}
            onManagePersonas={() => setShowPersonaManager(true)}
          />
        </div>
      ) : (
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
      )}

      {/* Docked video/audio detail panel — a direct sibling of .chat-page (not nested
          inside it), squeezing the chat column instead of floating over it or stacking
          below the composer. Collapses to a slim rail (same pattern as .chat-sidebar)
          rather than fully disappearing, so its toggle icon stays reachable in the same
          top-right spot whether open or closed — no separate open button needed
          elsewhere. `wide` gives it more room once the left chat-sidebar is collapsed,
          instead of leaving that freed-up width unused. Opened by the Summarize/Generate
          Notes quick actions (runQuickAction), the "Transcribe to get insights" prompt
          above the composer, or this toggle. */}
      {video && !activePm && (
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

      {addPmOpen && (
        <div className="modal-backdrop" onClick={() => setAddPmOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="transcript-drawer-header">
              <h2>Add AI Project Manager</h2>
              <button type="button" className="icon-btn" title="Close" onClick={() => setAddPmOpen(false)}>
                <X size={20} />
              </button>
            </div>

            <label className="field">
              <span>Name</span>
              <input value={newPmName} onChange={(e) => setNewPmName(e.target.value)} placeholder="e.g. Sprint Bot" autoFocus />
            </label>

            <label className="field">
              <div className="pm-field-label-row">
                <span>Persona</span>
                <span className="pm-info-icon" title={`Focuses on: ${newPmEffectiveFocus}`}>
                  <Info size={14} />
                </span>
              </div>
              <select value={newPmPersona} onChange={(e) => setNewPmPersona(e.target.value)}>
                {listAllPersonas(customPersonas).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <small className="field-hint">
                {resolvePersonaById(newPmPersona, customPersonas).description}{" "}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setAddPmOpen(false);
                    setShowPersonaManager(true);
                  }}
                >
                  Manage personas
                </button>
              </small>
            </label>

            <div className="retranscribe-row">
              <label className="field">
                <span>Team</span>
                <select value={newPmTeamId} onChange={(e) => setNewPmTeamId(e.target.value)} disabled={teams.length === 0}>
                  {teams.length === 0 && <option value="">No teams yet</option>}
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {teams.length === 0 && (
                  <small className="field-hint">Create a team in Library &gt; Team first.</small>
                )}
              </label>

              <label className="field">
                <span>Summary model</span>
                <select value={newPmChatProfileId} onChange={(e) => setNewPmChatProfileId(e.target.value)} disabled={chatProfiles.length === 0}>
                  {chatProfiles.length === 0 && <option value="">No models configured</option>}
                  {chatProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {chatProfiles.length === 0 && (
                  <small className="field-hint">
                    <Link to="/settings">Add a model in Settings</Link>
                  </small>
                )}
              </label>

              <label className="field">
                <span>Transcription model</span>
                <select
                  value={newPmTranscribeModel}
                  onChange={(e) => setNewPmTranscribeModel(e.target.value)}
                  disabled={pmTranscribeOptions.length === 0}
                >
                  {pmTranscribeOptions.length === 0 && <option value="">No models configured</option>}
                  {pmTranscribeOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {pmTranscribeOptions.length === 0 && (
                  <small className="field-hint">
                    <Link to="/settings">Add a model in Settings</Link>
                  </small>
                )}
              </label>
            </div>

            <div className="actions modal-actions">
              <button
                type="button"
                className="primary"
                onClick={createProjectManager}
                disabled={creatingPm || !newPmName.trim() || !newPmTeamId}
              >
                {creatingPm ? "Adding…" : "Add"}
              </button>
              <button type="button" onClick={() => setAddPmOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
