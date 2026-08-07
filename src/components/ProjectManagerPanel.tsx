import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Files, Info, MessageCircle, Settings, Sparkles, X } from "lucide-react";
import type { Video } from "@shared/types/models";
import type { PmPersonaId, PmRunResult, ProjectManager } from "@shared/types/projectManager";
import type { CustomPersona } from "@shared/types/persona";
import { listAllPersonas, resolvePersonaById } from "@shared/constants/pmPersonas";
import { useCustomPersonas } from "../hooks/useCustomPersonas";
import { DEFAULT_TRANSCRIPTION_LANGUAGE } from "@shared/constants/languages";
import { WHISPER_MODELS } from "@shared/constants/whisperModels";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";
import { useTeamFiles } from "../hooks/useTeams";
import { useStorageFiles } from "../hooks/useStorage";
import { useLlmProfiles } from "../hooks/useLlmProfiles";
import {
  useDeleteProjectManager,
  useGenerateInsight,
  useGenerateOverallInsight,
  useMarkProjectManagerAutoProcessed,
  useRunProjectManager,
  useSaveProjectManager,
} from "../hooks/useProjectManagers";
import { TeamsService } from "../services/teams/TeamsService";
import { StorageService } from "../services/storage/StorageService";
import { TranscriptionService } from "../services/transcription/TranscriptionService";
import { SettingsService } from "../services/settings/SettingsService";
import { AiService } from "../services/ai/AiService";
import { useSetVideoTranscript } from "../hooks/useVideos";
import { ChatMessageContent } from "./ChatMessageContent";
import "./ProjectManagerPanel.css";

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function transcriptText(video: Video | undefined): string | null {
  if (!video?.transcript) return null;
  return video.transcript.segments.map((s) => `[${fmt(s.start)}] ${s.speaker}: ${s.text}`).join("\n");
}

const MAX_CONTEXT_CHARS_PER_FILE = 6000;

interface PmFile {
  id: string;
  name: string;
  uploadedBy?: string;
}

function InsightSkeleton({ className }: { className: string }) {
  return (
    <div className={`${className} pm-skeleton`}>
      <div className="pm-skeleton-line" style={{ width: "92%" }} />
      <div className="pm-skeleton-line" style={{ width: "78%" }} />
      <div className="pm-skeleton-line" style={{ width: "60%" }} />
    </div>
  );
}

function buildSystemPrompt(pm: ProjectManager, files: PmFile[], videosByFile: Record<string, Video>, customPersonas: CustomPersona[]): string {
  const persona = resolvePersonaById(pm.persona, customPersonas);
  const sections = files.map((f) => {
    const insight = pm.insights.find((i) => i.fileId === f.id);
    const body = insight?.detailed ?? transcriptText(videosByFile[f.id]) ?? "(not transcribed yet)";
    const header = f.uploadedBy ? `${f.name} (uploaded by ${f.uploadedBy})` : f.name;
    return `### ${header}\n${body.slice(0, MAX_CONTEXT_CHARS_PER_FILE)}`;
  });
  return (
    `You are acting as a ${persona.name} for the team "${pm.teamName}". Focus on ${persona.focus}. ` +
    `Answer questions using the team's files below; be concise and only use information from them, or say so if ` +
    `something isn't covered.\n\n${sections.join("\n\n")}`
  );
}

interface PmChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

function chatKey(pmId: string): string {
  return `pmChat.${pmId}`;
}

function loadChat(pmId: string): PmChatMessage[] {
  try {
    const raw = localStorage.getItem(chatKey(pmId));
    return raw ? (JSON.parse(raw) as PmChatMessage[]) : [];
  } catch {
    return [];
  }
}

function saveChat(pmId: string, messages: PmChatMessage[]): void {
  localStorage.setItem(chatKey(pmId), JSON.stringify(messages));
}

interface PipelineProgress {
  phase: "transcribing" | "insights" | "overall";
  current: number;
  total: number;
  fileName: string;
}

export function ProjectManagerPanel({
  pm,
  onDeleted,
  onManagePersonas,
}: {
  pm: ProjectManager;
  onDeleted: () => void;
  onManagePersonas: () => void;
}) {
  const isS3 = pm.storageProvider === "s3";
  const { data: teamFiles = [], isLoading: teamFilesLoading } = useTeamFiles(pm.teamId, "active", !isS3);
  const { data: storageFiles = [], isLoading: storageFilesLoading } = useStorageFiles(pm.teamId, isS3);
  const files: PmFile[] = isS3
    ? storageFiles.map((f) => ({ id: f.id, name: f.name }))
    : teamFiles.map((f) => ({ id: f.id, name: f.name, uploadedBy: f.uploadedBy }));
  const filesLoading = isS3 ? storageFilesLoading : teamFilesLoading;
  const { data: customPersonas = [] } = useCustomPersonas();
  const persona = resolvePersonaById(pm.persona, customPersonas);
  const { data: profiles = [] } = useLlmProfiles();
  const chatProfiles = profiles.filter((p) => p.capabilities.includes("chat"));
  const byokTranscribeProfiles = profiles.filter((p) => p.capabilities.includes("transcribe"));

  const [configureOpen, setConfigureOpen] = useState(false);


  const [videosByFile, setVideosByFile] = useState<Record<string, Video>>({});
  useEffect(() => {
    for (const file of files) {
      if (videosByFile[file.id]) continue;
      const download = isS3 ? StorageService.downloadToLibrary(file.id) : TeamsService.downloadToLibrary(pm.teamId, file.id);
      download
        .then((v) => setVideosByFile((m) => ({ ...m, [file.id]: v })))
        .catch(() => {});
    }
  }, [files, pm.teamId, isS3]);

  const [modelStatuses, setModelStatuses] = useState<WhisperModelStatus[] | null>(null);
  useEffect(() => {
    SettingsService.getWhisperModelStatuses().then(setModelStatuses).catch(() => {});
  }, []);
  const downloadedModels = WHISPER_MODELS.filter((m) => {
    const status = modelStatuses?.find((s) => s.size === m.size);
    return status?.downloaded && !status.downloading;
  });
  const defaultModelSize = downloadedModels[0]?.size;
  const defaultByokId = byokTranscribeProfiles[0]?.id;
  const hasAnyTranscribeModel = !!defaultModelSize || !!defaultByokId;

  const transcribeOptions = [
    ...downloadedModels.map((m) => ({ value: m.size as string, label: m.label })),
    ...byokTranscribeProfiles.map((p) => ({ value: `byok:${p.id}`, label: p.name || "BYOK" })),
  ];


  function resolveTranscribeSelection(): { modelSize?: WhisperModelSize; byokId?: string } {
    const configured = pm.transcribeModel;
    if (configured) {
      return configured.startsWith("byok:") ? { byokId: configured.slice(5) } : { modelSize: configured as WhisperModelSize };
    }
    return defaultByokId ? { byokId: defaultByokId } : { modelSize: defaultModelSize };
  }

  const setVideoTranscript = useSetVideoTranscript();
  const generateInsight = useGenerateInsight();
  const generateOverallInsight = useGenerateOverallInsight();
  const markAutoProcessed = useMarkProjectManagerAutoProcessed();
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [fileError, setFileError] = useState<{ id: string; message: string } | null>(null);
  const [overallError, setOverallError] = useState<string | null>(null);

  async function transcribeFile(file: PmFile): Promise<Video | null> {
    setTranscribingId(file.id);
    setFileError(null);
    try {
      const video =
        videosByFile[file.id] ??
        (await (isS3 ? StorageService.downloadToLibrary(file.id) : TeamsService.downloadToLibrary(pm.teamId, file.id)));
      const { modelSize, byokId } = resolveTranscribeSelection();
      const transcript = await TranscriptionService.transcribe(video.filePath, DEFAULT_TRANSCRIPTION_LANGUAGE, modelSize, byokId);
      const updated = await setVideoTranscript.mutateAsync({ id: video.id, transcript });
      setVideosByFile((m) => ({ ...m, [file.id]: updated }));
      return updated;
    } catch (e) {
      setFileError({ id: file.id, message: String(e) });
      return null;
    } finally {
      setTranscribingId(null);
    }
  }


  const [pipeline, setPipeline] = useState<PipelineProgress | null>(null);
  const autoRunStarted = useRef(false);
  useEffect(() => {
    autoRunStarted.current = false;
  }, [pm.id]);
  useEffect(() => {
    if (autoRunStarted.current || pm.autoProcessedAt || filesLoading || !hasAnyTranscribeModel) return;
    if (files.length === 0) return;
    autoRunStarted.current = true;
    markAutoProcessed.mutate(pm.id);
    setOverallError(null);
    (async () => {
      const total = files.length;
      let anyInsight = pm.insights.length > 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const alreadyTranscribed = videosByFile[file.id]?.transcript;
        let video: Video | null = videosByFile[file.id] ?? null;
        if (!alreadyTranscribed) {
          setPipeline({ phase: "transcribing", current: i + 1, total, fileName: file.name });
          video = await transcribeFile(file);
        }
 
        const alreadyInsighted = pm.insights.some((i) => i.fileId === file.id);
        if (video?.transcript && !alreadyInsighted) {
          setPipeline({ phase: "insights", current: i + 1, total, fileName: file.name });
          const ok = await generateInsight
            .mutateAsync({ pmId: pm.id, fileId: file.id, fileName: file.name })
            .then(() => true)
            .catch((e) => {

              setFileError({ id: file.id, message: String(e) });
              return false;
            });
          anyInsight = anyInsight || ok;
        }
      }
      if (anyInsight) {
        setPipeline({ phase: "overall", current: total, total, fileName: "" });
        await generateOverallInsight.mutateAsync({ pmId: pm.id }).catch((e) => setOverallError(String(e)));
      }
      setPipeline(null);
    })();
  }, [files, filesLoading, hasAnyTranscribeModel, pm.id, pm.autoProcessedAt]);

  const pipelinePct = pipeline
    ? pipeline.phase === "overall"
      ? 96
      : Math.round(((pipeline.current - (pipeline.phase === "insights" ? 0.5 : 1)) / pipeline.total) * 100)
    : 0;


  const trackRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  function updateScrollState() {
    const el = trackRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }
  useEffect(updateScrollState, [files.length]);

  function scrollCarousel(dir: 1 | -1) {
    const el = trackRef.current;
    if (!el) return;
    const cardWidth = el.querySelector(".pm-file-card")?.clientWidth ?? el.clientWidth / 3;
    el.scrollBy({ left: dir * (cardWidth + 14), behavior: "smooth" });
  }

  return (
    <div className="pm-panel">
      <div className="pm-panel-header">
        <div>
          <h2 className="pm-panel-title">{pm.name}</h2>
          <p className="muted pm-panel-subtitle">
            {persona.name} · Team: {pm.teamName}
          </p>
        </div>
        <button type="button" className="icon-btn" title="Configure" onClick={() => setConfigureOpen(true)}>
          <Settings size={18} />
        </button>
      </div>

      {pipeline && (
        <div className="pm-progress">
          <div className="pm-progress-bar">
            <div className="pm-progress-fill" style={{ width: `${Math.min(100, Math.max(4, pipelinePct))}%` }} />
          </div>
          <p className="muted pm-progress-text">
            {pipeline.phase === "transcribing" && `Transcribing ${pipeline.current}/${pipeline.total} — ${pipeline.fileName}`}
            {pipeline.phase === "insights" && `Generating insights ${pipeline.current}/${pipeline.total} — ${pipeline.fileName}`}
            {pipeline.phase === "overall" && "Summarizing overall insight…"}
          </p>
        </div>
      )}

      <div className="pm-panel-body">
        <div className="pm-overall">
          <div className="pm-overall-header">
            <div className="pm-overall-title">
              <Sparkles size={16} />
              <h3>Overall insight</h3>
            </div>
            <div className="pm-overall-meta">
              <span className="muted">
                {files.length} file{files.length === 1 ? "" : "s"} in {pm.teamName}
              </span>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  setOverallError(null);
                  generateOverallInsight
                    .mutateAsync({ pmId: pm.id })
                    .then(() => setOverallError(null))
                    .catch((e) => setOverallError(String(e)));
                }}
                disabled={pm.insights.length === 0 || generateOverallInsight.isPending}
              >
                {generateOverallInsight.isPending ? "Generating…" : pm.overallInsight ? "Regenerate" : "Generate"}
              </button>
            </div>
          </div>
          {overallError && <p className="error pm-overall-error">{overallError}</p>}

          {pm.overallInsight ? (
            <div className="pm-overall-text">
              <ChatMessageContent content={pm.overallInsight.quick} />
            </div>
          ) : pipeline || generateOverallInsight.isPending ? (

            <InsightSkeleton className="pm-overall-text" />
          ) : (
            <p className="muted">
              {pm.insights.length === 0 ? "Generate a file insight below first, then an overall summary." : "No overall insight yet."}
            </p>
          )}
        </div>

        {!hasAnyTranscribeModel && (
          <p className="muted field-hint-inline">
            No transcription model configured — set one up in <Link to="/settings">Settings &gt; Models</Link>.
          </p>
        )}
        {filesLoading && <p className="muted">Loading files…</p>}
        {!filesLoading && files.length === 0 && <p className="muted">No files in this team yet.</p>}

        {files.length > 0 && (
          <div className="pm-carousel">
            <div className="pm-carousel-header">
              <h3>
                <Files size={15} /> Files &amp; insights
              </h3>
              <div className="pm-carousel-controls">
                <button type="button" className="icon-btn" disabled={!canScrollLeft} onClick={() => scrollCarousel(-1)}>
                  <ChevronLeft size={18} />
                </button>
                <button type="button" className="icon-btn" disabled={!canScrollRight} onClick={() => scrollCarousel(1)}>
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>

            <div className="pm-carousel-viewport">
              <div className="pm-carousel-track" ref={trackRef} onScroll={updateScrollState}>
                {files.map((file) => {
                  const video = videosByFile[file.id];
                  const insight = pm.insights.find((i) => i.fileId === file.id);
                  const statusKind = transcribingId === file.id ? "syncing" : !video ? "syncing" : video.transcript ? "done" : "pending";
                  return (
                    <div key={file.id} className={`pm-file-card pm-file-card-${statusKind}`}>
                      <div className="pm-file-card-header">
                        <span className="pm-file-card-user">{file.uploadedBy ?? file.name}</span>
                        {file.uploadedBy && <span className="pm-file-card-name">{file.name}</span>}
                      </div>

                      {insight ? (
                        <div className="pm-file-card-insight">
                          <ChatMessageContent content={insight.quick} />
                        </div>
                      ) : pipeline ? (

                        <InsightSkeleton className="pm-file-card-insight" />
                      ) : (
                        <p className="muted pm-file-card-empty">No insight yet.</p>
                      )}

                      {fileError?.id === file.id && <p className="error">{fileError.message}</p>}
                    </div>
                  );
                })}
              </div>
              <div className={canScrollLeft ? "pm-carousel-fade left visible" : "pm-carousel-fade left"} />
              <div className={canScrollRight ? "pm-carousel-fade right visible" : "pm-carousel-fade right"} />
            </div>
          </div>
        )}

        <div className="pm-chat-section">
          <h3>
            <MessageCircle size={15} /> Ask about these files
          </h3>
          <PmChat pm={pm} files={files} videosByFile={videosByFile} chatProfiles={chatProfiles} customPersonas={customPersonas} />
        </div>
      </div>

      {configureOpen && (
        <div className="modal-backdrop" onClick={() => setConfigureOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="transcript-drawer-header">
              <h2>Configure {pm.name}</h2>
              <button type="button" className="icon-btn" title="Close" onClick={() => setConfigureOpen(false)}>
                <X size={20} />
              </button>
            </div>
            <PmConfigure
              pm={pm}
              chatProfiles={chatProfiles}
              transcribeOptions={transcribeOptions}
              customPersonas={customPersonas}
              onDeleted={onDeleted}
              onManagePersonas={() => {
                setConfigureOpen(false);
                onManagePersonas();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function PmChat({
  pm,
  files,
  videosByFile,
  chatProfiles,
  customPersonas,
}: {
  pm: ProjectManager;
  files: PmFile[];
  videosByFile: Record<string, Video>;
  chatProfiles: { id: string; name: string }[];
  customPersonas: CustomPersona[];
}) {
  const [history, setHistory] = useState<PmChatMessage[]>(() => loadChat(pm.id));
  useEffect(() => setHistory(loadChat(pm.id)), [pm.id]);
  const [question, setQuestion] = useState("");
  const [profileId, setProfileId] = useState("");
  const appliedForPmId = useRef<string | null>(null);
  useEffect(() => {
    if (appliedForPmId.current === pm.id || chatProfiles.length === 0) return;
    appliedForPmId.current = pm.id;
    const preferred = pm.chatProfileId && chatProfiles.some((p) => p.id === pm.chatProfileId) ? pm.chatProfileId : chatProfiles[0].id;
    setProfileId(preferred);
  }, [pm.id, pm.chatProfileId, chatProfiles]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    const q = question.trim();
    if (!q || busy || !profileId) return;
    const next: PmChatMessage[] = [...history, { role: "user", content: q, timestamp: new Date().toISOString() }];
    setHistory(next);
    setQuestion("");
    setBusy(true);
    setError(null);
    try {
      const system = buildSystemPrompt(pm, files, videosByFile, customPersonas);
      const reply = await AiService.chat(
        null,
        next.map((m) => ({ role: m.role, content: m.content })),
        q,
        profileId,
        system
      );
      const final: PmChatMessage[] = [...next, { role: "assistant", content: reply.content, timestamp: new Date().toISOString() }];
      setHistory(final);
      saveChat(pm.id, final);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pm-chat-box">
      <div className="pm-chat-log">
        {history.length === 0 && (
          <div className="pm-chat-empty">
            <p className="muted">
              Ask {resolvePersonaById(pm.persona, customPersonas).name} anything about {pm.teamName}&apos;s files.
            </p>
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <ChatMessageContent content={m.content} timestamp={m.timestamp} />
          </div>
        ))}
        {error && <p className="error">{error}</p>}
      </div>
      <div className="pm-chat-composer">
        <div className="chat-input">
          <input
            value={question}
            disabled={busy || !profileId}
            placeholder={profileId ? "Ask about this team…" : "Set a chat model in Configure first"}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
          />
          <button onClick={() => ask()} disabled={busy || !question.trim() || !profileId}>
            {busy ? "…" : "Ask"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PmConfigure({
  pm,
  chatProfiles,
  transcribeOptions,
  customPersonas,
  onDeleted,
  onManagePersonas,
}: {
  pm: ProjectManager;
  chatProfiles: { id: string; name: string }[];
  transcribeOptions: { value: string; label: string }[];
  customPersonas: CustomPersona[];
  onDeleted: () => void;
  onManagePersonas: () => void;
}) {
  const [name, setName] = useState(pm.name);
  const [persona, setPersona] = useState<PmPersonaId>(pm.persona);
  const [triggerMode, setTriggerMode] = useState(pm.triggerMode);
  const [scheduleTime, setScheduleTime] = useState(pm.scheduleTime ?? "09:00");
  const [chatProfileId, setChatProfileId] = useState(pm.chatProfileId || chatProfiles[0]?.id || "");
  const [transcribeModel, setTranscribeModel] = useState(pm.transcribeModel || transcribeOptions[0]?.value || "");
  const [runResult, setRunResult] = useState<PmRunResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(pm.name);
    setPersona(pm.persona);
    setTriggerMode(pm.triggerMode);
    setScheduleTime(pm.scheduleTime ?? "09:00");
    setChatProfileId(pm.chatProfileId || chatProfiles[0]?.id || "");
    setTranscribeModel(pm.transcribeModel || transcribeOptions[0]?.value || "");
    setRunResult(null);
    setConfirmDelete(false);
  }, [pm.id]);


  useEffect(() => {
    if (!chatProfileId && chatProfiles[0]) setChatProfileId(chatProfiles[0].id);
  }, [chatProfiles, chatProfileId]);
  useEffect(() => {
    if (!transcribeModel && transcribeOptions[0]) setTranscribeModel(transcribeOptions[0].value);
  }, [transcribeOptions, transcribeModel]);

  const saveMutation = useSaveProjectManager();
  const deleteMutation = useDeleteProjectManager();
  const runMutation = useRunProjectManager();

  function save() {
    saveMutation.mutate({
      ...pm,
      name: name.trim() || pm.name,
      persona,
      triggerMode,
      scheduleTime: triggerMode === "scheduled" ? scheduleTime : null,
      chatProfileId: chatProfileId || null,
      transcribeModel: transcribeModel || null,
    });
  }

  const personaDef = resolvePersonaById(persona, customPersonas);

  async function runNow() {
    setRunResult(null);
    const result = await runMutation.mutateAsync(pm.id);
    setRunResult(result);
  }

  return (
    <div className="pm-configure">
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="field">
        <div className="pm-field-label-row">
          <span>Persona</span>
          <span className="pm-info-icon" title={`Focuses on: ${personaDef.focus}`}>
            <Info size={14} />
          </span>
        </div>
        <select value={persona} onChange={(e) => setPersona(e.target.value)}>
          {listAllPersonas(customPersonas).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <small className="field-hint">
          {personaDef.description} ·{" "}
          <button type="button" className="link-btn" onClick={onManagePersonas}>
            Manage personas
          </button>
        </small>
      </label>

      <fieldset className="field">
        <legend>Trigger</legend>
        <label className="pm-radio">
          <input type="radio" checked={triggerMode === "manual"} onChange={() => setTriggerMode("manual")} />
          Manual (Run now button only)
        </label>
        <label className="pm-radio">
          <input type="radio" checked={triggerMode === "scheduled"} onChange={() => setTriggerMode("scheduled")} />
          Scheduled — every day at
          <input
            type="time"
            value={scheduleTime}
            disabled={triggerMode !== "scheduled"}
            onChange={(e) => setScheduleTime(e.target.value)}
          />
        </label>
        {triggerMode === "scheduled" && (
          <small className="field-hint">Only fires while Doculigent is open — a missed time isn't caught up later.</small>
        )}
      </fieldset>

      <label className="field">
        <span>Chat model</span>
        <select value={chatProfileId} onChange={(e) => setChatProfileId(e.target.value)}>
          {chatProfiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {chatProfiles.length === 0 && (
          <small className="field-hint">
            No chat model configured — add one in <Link to="/settings">Settings &gt; Models</Link>.
          </small>
        )}
      </label>

      <label className="field">
        <span>Transcribe model</span>
        <select value={transcribeModel} onChange={(e) => setTranscribeModel(e.target.value)}>
          {transcribeOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {transcribeOptions.length === 0 && (
          <small className="field-hint">
            No transcription model configured — add one in <Link to="/settings">Settings &gt; Models</Link>.
          </small>
        )}
      </label>

      {pm.lastRunAt && <p className="muted">Last run: {new Date(pm.lastRunAt).toLocaleString()}</p>}

      <div className="actions">
        <button type="button" className="primary" onClick={save} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={runNow} disabled={runMutation.isPending}>
          {runMutation.isPending ? "Running…" : "Run now"}
        </button>
        <button type="button" className="danger" onClick={() => setConfirmDelete(true)} disabled={deleteMutation.isPending}>
          Delete
        </button>
      </div>

      {runResult && (
        <div className={runResult.ok ? "muted" : "error"}>
          <p>{runResult.message}</p>
          {runResult.actionResults.map((r, i) => (
            <p key={i} className={r.ok ? "muted" : "error"}>
              {r.kind}: {r.message}
            </p>
          ))}
        </div>
      )}

      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete "{pm.name}"?</h2>
            <p className="muted">This removes the Project Manager and its cached insights. Files in the team aren't affected. This can't be undone.</p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => deleteMutation.mutate(pm.id, { onSuccess: onDeleted })}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
