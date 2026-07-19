import { useState } from "react";
import type { ChatMessage, Summary, Transcript, Video } from "@shared/types/models";
import { TranscriptionService } from "../services/transcription/TranscriptionService";
import { AiService } from "../services/ai/AiService";

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface AiWorkspaceProps {
  video: Video;
  /** Which saved model profile to use for summarize/chat; omit to use the globally
   *  active one (see Settings). The AI Assistant tab's model picker sets this. */
  profileId?: string;
}

/**
 * Transcript+summary (left) and chat (right) for one video. Transcript/summary are kept
 * as local component state rather than persisted onto the video record — matching the
 * original app's actual (session-only) behavior, since transcription is still a stub
 * (FUNCTIONALITY.md §10). Persisting them is natural follow-up work once that stops being
 * true. Shared by the per-video route (AiPage) and the AI Assistant tab (AiAssistantPage)
 * — render with `key={video.id}` so switching videos resets this local state.
 */
export function AiWorkspace({ video, profileId }: AiWorkspaceProps) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState<null | "transcribe" | "summarize">(null);
  const [error, setError] = useState<string | null>(null);

  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  async function transcribe() {
    setBusy("transcribe");
    setError(null);
    try {
      setTranscript(await TranscriptionService.transcribe(video.filePath));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function summarize() {
    if (!transcript) return;
    setBusy("summarize");
    setError(null);
    try {
      setSummary(await AiService.summarize(transcript, profileId));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function ask() {
    if (!transcript || !question.trim()) return;
    const q = question.trim();
    const next: ChatMessage[] = [...history, { role: "user", content: q }];
    setHistory(next);
    setQuestion("");
    setChatBusy(true);
    setChatError(null);
    try {
      const reply = await AiService.chat(transcript, next, q, profileId);
      setHistory([...next, reply]);
    } catch (e) {
      setChatError(String(e));
    } finally {
      setChatBusy(false);
    }
  }

  return (
    <div className="ai-grid">
      <section className="panel transcript">
        <h1>Transcript &amp; summary</h1>

        <div className="actions">
          <button onClick={transcribe} disabled={busy !== null}>
            {busy === "transcribe" ? "Transcribing…" : "Transcribe + diarize"}
          </button>
          <button onClick={summarize} disabled={!transcript || busy !== null}>
            {busy === "summarize" ? "Summarizing…" : "Summarize"}
          </button>
        </div>

        {summary && (
          <div className="summary">
            <h2>Summary</h2>
            <p>
              <strong>TL;DR:</strong> {summary.tldr}
            </p>
            {summary.keyPoints.length > 0 && (
              <>
                <h3>Key points</h3>
                <ul>
                  {summary.keyPoints.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </>
            )}
            {summary.actionItems.length > 0 && (
              <>
                <h3>Action items</h3>
                <ul>
                  {summary.actionItems.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        <div className="segments">
          {transcript?.segments.map((seg, i) => (
            <div key={i} className="segment">
              <span className="ts">{fmt(seg.start)}</span>
              <span className="spk">{seg.speaker}</span>
              <span className="txt">{seg.text}</span>
            </div>
          ))}
          {!transcript && <p className="muted">No transcript yet.</p>}
        </div>

        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel chat">
        <h1>Chat with video</h1>
        {!transcript && <p className="muted">Transcribe first to enable chat.</p>}

        <div className="chat-log">
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
        </div>

        <div className="chat-input">
          <input
            value={question}
            disabled={!transcript || chatBusy}
            placeholder="Ask about this recording…"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
          />
          <button onClick={ask} disabled={!transcript || chatBusy}>
            {chatBusy ? "…" : "Ask"}
          </button>
        </div>

        {chatError && <p className="error">{chatError}</p>}
      </section>
    </div>
  );
}
