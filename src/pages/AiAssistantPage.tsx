import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ChatMessage, Transcript } from "@shared/types/models";
import { useVideo, useVideos } from "../hooks/useVideos";
import { useActiveLlmProfileId, useLlmProfiles } from "../hooks/useLlmProfiles";
import { TranscriptionService } from "../services/transcription/TranscriptionService";
import { AiService } from "../services/ai/AiService";

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Chatbot-style hub: the conversation fills the page, with the model and the attached
 * recording/transcript chosen from a compact bar right above the input — unlike AiPage
 * (reached from a specific video, two-column transcript+chat layout), this doesn't
 * require navigating from a video first and reads like a normal chat app.
 */
export function AiAssistantPage() {
  const { data: videos = [] } = useVideos("");
  const { data: profiles = [] } = useLlmProfiles();
  const { data: activeProfileId } = useActiveLlmProfileId();

  const [videoId, setVideoId] = useState("");
  const { data: video } = useVideo(videoId || undefined);
  const [profileOverride, setProfileOverride] = useState("");
  const profileId = profileOverride || activeProfileId || undefined;

  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [transcribing, setTranscribing] = useState(false);

  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switching the attached recording starts a fresh conversation, and picks up that
  // video's already-persisted transcript (if it has one) instead of requiring re-transcribe.
  useEffect(() => {
    setTranscript(video?.transcript ?? null);
    setHistory([]);
    setError(null);
  }, [video?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function transcribe() {
    if (!video) return;
    setTranscribing(true);
    setError(null);
    try {
      setTranscript(await TranscriptionService.transcribe(video.filePath));
    } catch (e) {
      setError(String(e));
    } finally {
      setTranscribing(false);
    }
  }

  async function ask() {
    if (!transcript || !question.trim() || chatBusy) return;
    const q = question.trim();
    const next: ChatMessage[] = [...history, { role: "user", content: q }];
    setHistory(next);
    setQuestion("");
    setChatBusy(true);
    setError(null);
    try {
      const reply = await AiService.chat(transcript, next, q, profileId);
      setHistory([...next, reply]);
    } catch (e) {
      setError(String(e));
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <div className="chat-page">
      <div className="chat-page-log">
        {video && (
          <div className="chat-resource-card">
            <span className="chat-resource-title">🎬 {video.title}</span>
            {transcript ? (
              <span className="muted">Transcribed ✓</span>
            ) : (
              <button type="button" onClick={transcribe} disabled={transcribing}>
                {transcribing ? "Transcribing…" : "Transcribe this recording"}
              </button>
            )}
          </div>
        )}

        {!video && (
          <div className="chat-page-empty">
            <p className="muted">Pick a recording below to start chatting.</p>
            {videos.length === 0 && (
              <p className="muted">No recordings yet — head to the Record tab.</p>
            )}
          </div>
        )}

        {video && !transcript && !transcribing && (
          <div className="chat-page-empty">
            <p className="muted">Transcribe this recording to start chatting about it.</p>
          </div>
        )}

        {history.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="msg-content">{m.content}</div>
            {m.citations?.map((c, j) => (
              <button key={j} className="citation" title={c.quote}>
                ↷ {fmt(c.timestamp)}
              </button>
            ))}
          </div>
        ))}

        {error && <p className="error">{error}</p>}
      </div>

      <div className="chat-page-composer">
        <div className="chat-page-toolbar">
          <select
            value={profileOverride || activeProfileId || ""}
            onChange={(e) => setProfileOverride(e.target.value)}
            disabled={profiles.length === 0}
            aria-label="Model"
          >
            {profiles.length === 0 && <option value="">No models configured</option>}
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === activeProfileId ? " (active)" : ""}
              </option>
            ))}
          </select>

          <select value={videoId} onChange={(e) => setVideoId(e.target.value)} aria-label="Recording">
            <option value="">+ Add recording…</option>
            {videos.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title}
              </option>
            ))}
          </select>

          {profiles.length === 0 && (
            <span className="muted">
              <Link to="/settings">Add a model in Settings</Link>
            </span>
          )}
        </div>

        <div className="chat-input">
          <input
            value={question}
            disabled={!transcript || chatBusy}
            placeholder={transcript ? "Ask about this recording…" : "Attach and transcribe a recording first…"}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
          />
          <button onClick={ask} disabled={!transcript || chatBusy || !question.trim()}>
            {chatBusy ? "…" : "Ask"}
          </button>
        </div>
      </div>
    </div>
  );
}
