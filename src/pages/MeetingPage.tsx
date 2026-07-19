import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { CaptureTarget, TranscriptSegment } from "@shared/types/models";
import { DEFAULT_TRANSCRIPTION_LANGUAGE, TRANSCRIPTION_LANGUAGES } from "@shared/constants/languages";
import { DEFAULT_WHISPER_MODEL, WHISPER_MODELS } from "@shared/constants/whisperModels";
import { audioRecordingService, getSystemAudioStream } from "../services/recording/AudioRecordingService";
import { TranscriptionService } from "../services/transcription/TranscriptionService";
import { SettingsService } from "../services/settings/SettingsService";
import { LiveWaveform } from "../components/LiveWaveform";

const SPEAKER_COLORS = ["#5b4bf5", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444"];
function colorForSpeaker(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return SPEAKER_COLORS[hash % SPEAKER_COLORS.length];
}

/**
 * Just audio: a mic recording with a live transcript, not a screen capture. Auto-joining
 * Zoom/Meet/Teams is out of scope (no native integration with those apps) — this records
 * whatever the mic picks up, transcribing it live in short rolling chunks (see
 * AudioRecordingService) so you get a running chat-style feed while you talk instead of
 * waiting until you stop. No speaker diarization yet (see whisper.ts), so every line is
 * "Speaker" today — the chat feed already renders per-speaker colors/labels for whenever
 * that lands.
 */
export function MeetingPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState("Untitled meeting");
  const [language, setLanguage] = useState(DEFAULT_TRANSCRIPTION_LANGUAGE);
  // Both sources default on, matching "just works" expectations — restored from the last
  // saved choice below once that loads, same pattern as RecordPage's overlay/mic restore.
  const [micEnabled, setMicEnabled] = useState(true);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [systemAudioEnabled, setSystemAudioEnabled] = useState(true);
  const [systemAudioSourceId, setSystemAudioSourceId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [messages, setMessages] = useState<TranscriptSegment[]>([]);
  const [pendingChunks, setPendingChunks] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [savedVideoId, setSavedVideoId] = useState<string | null>(null);

  // Which Whisper model size is transcribing (see Settings > Transcription) — fetched
  // fresh on mount so switching it in Settings and coming back here shows the change.
  const [whisperModel, setWhisperModel] = useState(DEFAULT_WHISPER_MODEL);
  useEffect(() => {
    SettingsService.getWhisperModel().then(setWhisperModel).catch(() => { });
  }, []);

  // Mic device list for the picker below — labels only populate once permission's been
  // granted at least once (same caveat as RecordPage's device pickers), so this also
  // re-runs on 'devicechange' to pick up devices plugged in mid-session.
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const refreshDevices = () => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => setMicDevices(devices.filter((d) => d.kind === "audioinput")))
        .catch(() => { });
    };
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, []);

  // Screen list backing "system sound" — a screen (not window) has to be picked to unlock
  // desktop-audio capture at all, see desktopAudioConstraints; it doesn't actually scope
  // which audio comes through (Windows only exposes one system-wide loopback stream), so
  // there's nothing meaningful for the user to choose here — this just silently picks the
  // first screen (or the last-restored one, once settings load below) rather than
  // showing a dropdown for a choice that doesn't change anything.
  const [displayTargets, setDisplayTargets] = useState<CaptureTarget[]>([]);
  useEffect(() => {
    window.api.capture
      .listTargets()
      .then((targets) => {
        const displays = targets.filter((t) => t.kind === "display");
        setDisplayTargets(displays);
        setSystemAudioSourceId((current) => current ?? displays[0]?.id ?? null);
      })
      .catch(() => { });
  }, []);

  // Small live level meters for each source — same idea as RecordPage's mic-meter, a
  // setup-time preview independent of actually recording. Paused while `recording` is
  // true rather than run alongside the real capture (LiveWaveform covers that instead):
  // for system sound in particular, that would mean two concurrent desktop-audio
  // captures at once, which is unnecessary complexity for a meter that's only useful
  // before you hit record anyway.
  const [micLevel, setMicLevel] = useState(0);
  const [micPreviewError, setMicPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (!micEnabled || recording) {
      setMicLevel(0);
      setMicPreviewError(null);
      return;
    }
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        audioCtx = new AudioContext();
        await audioCtx.resume().catch(() => { });
        const source = audioCtx.createMediaStreamSource(s);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          setMicLevel(data.reduce((a, b) => a + b, 0) / data.length);
          raf = requestAnimationFrame(tick);
        };
        tick();
        setMicPreviewError(null);
      })
      .catch((e) => setMicPreviewError(String(e)));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
    };
  }, [micEnabled, micDeviceId, recording]);

  const [systemAudioLevel, setSystemAudioLevel] = useState(0);
  const [systemAudioPreviewError, setSystemAudioPreviewError] = useState<string | null>(null);
  useEffect(() => {
    if (!systemAudioEnabled || !systemAudioSourceId || recording) {
      setSystemAudioLevel(0);
      setSystemAudioPreviewError(null);
      return;
    }
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    getSystemAudioStream(systemAudioSourceId)
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        audioCtx = new AudioContext();
        await audioCtx.resume().catch(() => { });
        const source = audioCtx.createMediaStreamSource(s);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          setSystemAudioLevel(data.reduce((a, b) => a + b, 0) / data.length);
          raf = requestAnimationFrame(tick);
        };
        tick();
        setSystemAudioPreviewError(null);
      })
      .catch((e) => setSystemAudioPreviewError(String(e)));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
    };
  }, [systemAudioEnabled, systemAudioSourceId, recording]);

  // Restore the last-used language + audio-source choices, same idea as RecordPage's
  // overlay/mic restore. `settingsLoaded` gates the persist effect below so it can't fire
  // (and clobber the saved settings with the initial defaults) before this resolves.
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => {
    SettingsService.getMeetingSettings()
      .then((saved) => {
        if (saved.language) setLanguage(saved.language);
        if (saved.micEnabled !== null) setMicEnabled(saved.micEnabled);
        if (saved.micDeviceId !== null) setMicDeviceId(saved.micDeviceId);
        if (saved.systemAudioEnabled !== null) setSystemAudioEnabled(saved.systemAudioEnabled);
        if (saved.systemAudioSourceId !== null) setSystemAudioSourceId(saved.systemAudioSourceId);
      })
      .finally(() => setSettingsLoaded(true));
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    SettingsService.setMeetingSettings(language, micEnabled, micDeviceId, systemAudioEnabled, systemAudioSourceId).catch(
      () => { }
    );
  }, [language, micEnabled, micDeviceId, systemAudioEnabled, systemAudioSourceId, settingsLoaded]);

  // A transient top-right toast (not a persistent banner) each time the mic gets turned
  // off, auto-dismissing after a few seconds — same idea as RecordPage's save-status
  // toast (bottom-right, see .toast in styles.css) but positioned/timed differently since
  // this is a one-shot warning about a choice just made, not an ongoing background task.
  //
  // Only for choices made *this session*: without micWarningInitialized, restoring a
  // previously-saved "mic off" on mount (or just navigating back to this tab, which
  // remounts it) would flip micEnabled true->false right as settings load and trigger the
  // same toast as an actual user toggle — this skips exactly that first post-load run.
  const [showMicWarning, setShowMicWarning] = useState(false);
  const micWarningTimer = useRef<number | null>(null);
  const micWarningInitialized = useRef(false);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!micWarningInitialized.current) {
      micWarningInitialized.current = true;
      return;
    }
    if (micWarningTimer.current !== null) window.clearTimeout(micWarningTimer.current);
    if (!micEnabled) {
      setShowMicWarning(true);
      micWarningTimer.current = window.setTimeout(() => setShowMicWarning(false), 6000);
    } else {
      setShowMicWarning(false);
    }
    return () => {
      if (micWarningTimer.current !== null) window.clearTimeout(micWarningTimer.current);
    };
  }, [micEnabled, settingsLoaded]);

  // Same save location the Record tab uses (recording.saveAudio writes into it too, see
  // electron/main/ipc/recording.ts) — editable here too so you don't have to switch tabs
  // just to change where meetings land.
  const [saveDir, setSaveDir] = useState("");
  const [pickingDir, setPickingDir] = useState(false);
  useEffect(() => {
    window.api.settings.getSaveDir().then(setSaveDir).catch(() => { });
  }, []);

  async function browseSaveDir() {
    // Guards against stacking multiple native picker windows from rapid clicks — the
    // same bug documented (and fixed) in FUNCTIONALITY.md §8.
    if (pickingDir) return;
    setPickingDir(true);
    try {
      const picked = await window.api.settings.pickSaveDir();
      if (picked) {
        setSaveDir(picked);
        await window.api.settings.setSaveDir(picked);
      }
    } finally {
      setPickingDir(false);
    }
  }

  function commitSaveDir() {
    if (saveDir) window.api.settings.setSaveDir(saveDir).catch(() => { });
  }

  // Caps how many segments can be in flight to the (single-threaded) main process at
  // once. Without this, a model too slow to keep up with SEGMENT_MS (e.g. "small" on a
  // modest CPU) lets transcription requests queue up faster than they drain — and since
  // they run on the same process as every other IPC call, a long backlog was blocking
  // even unrelated things like the Stop button's save. Dropping a live-caption segment
  // instead of queuing it is a fine tradeoff: the full recording is unaffected either way
  // (see the master recorder in AudioRecordingService), only the live captions skip a beat.
  const pendingRef = useRef(0);

  async function handleSegment(samples: Float32Array) {
    if (pendingRef.current > 0) return;
    pendingRef.current++;
    setPendingChunks((n) => n + 1);
    try {
      const transcript = await TranscriptionService.transcribePcm(samples, language);
      if (transcript.segments.length > 0) {
        setMessages((prev) => [...prev, ...transcript.segments]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      pendingRef.current--;
      setPendingChunks((n) => n - 1);
    }
  }

  async function handleStart() {
    setBusy(true);
    setError(null);
    setMessages([]);
    setSavedVideoId(null);
    try {
      const node = await audioRecordingService.start(handleSegment, {
        mic: { enabled: micEnabled, deviceId: micDeviceId },
        systemAudio: { enabled: systemAudioEnabled, sourceId: systemAudioSourceId },
      });
      setAnalyser(node);
      setRecording(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      const { blob, durationSecs } = await audioRecordingService.stop();
      setRecording(false);
      setAnalyser(null);

      const audioBytes = await blob.arrayBuffer();
      const transcript = messages.length > 0 ? { language, engine: "whisper-local" as const, segments: messages } : null;
      const saved = await window.api.recording.saveAudio({ audioBytes, durationSecs, title, transcript });
      setSavedVideoId(saved.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="meeting-page">
      {showMicWarning && (
        <div className="toast meeting-mic-toast">
          <button type="button" className="toast-close" onClick={() => setShowMicWarning(false)} aria-label="Dismiss">
            ✕
          </button>
          <p>
            ⚠️ Microphone is off — if you record like this, your voice won't be picked up at all. Only the other side
            of the conversation (whatever the enabled sources actually hear, e.g. system sound) will be recorded and
            transcribed.
          </p>
        </div>
      )}

      <section className="panel meeting-record-panel">
        <h1>Meeting</h1>
        <p className="muted">
          Record audio and get a live transcript as you talk — auto-joining Zoom/Meet/Teams is coming soon
        </p>

        <div className="meeting-fields-row">
          <label className="field meeting-title-field">
            <span>Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={recording || busy}
            />
          </label>

          <label className="field meeting-savedir-field">
            <span>Save to</span>
            <div className="save-location">
              <input
                type="text"
                value={saveDir}
                onChange={(e) => setSaveDir(e.target.value)}
                onBlur={commitSaveDir}
                disabled={recording || busy}
              />
              <button
                type="button"
                className="icon-btn icon-btn-folder meeting-browse-btn"
                onClick={browseSaveDir}
                disabled={recording || busy || pickingDir}
                title={pickingDir ? "Choosing…" : "Browse…"}
              >
                📁
              </button>
            </div>
          </label>

          <label className="field meeting-language-field">
            <span>Language</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={recording || busy}>
              {TRANSCRIPTION_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="field meeting-audio-sources" disabled={recording || busy}>
          <legend>Audio sources</legend>

          <div className="meeting-source-row">
            <label className="checkbox">
              <input type="checkbox" checked={micEnabled} onChange={(e) => setMicEnabled(e.target.checked)} />
              Microphone
            </label>
            <select
              value={micDeviceId ?? ""}
              onChange={(e) => setMicDeviceId(e.target.value || null)}
              disabled={!micEnabled}
            >
              <option value="">Default</option>
              {micDevices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
            {!recording && micEnabled && (
              <div className="mic-meter-track meeting-meter-inline" title={micPreviewError ?? undefined}>
                <div className="mic-meter-fill" style={{ width: `${Math.min(100, (micLevel / 160) * 100)}%` }} />
              </div>
            )}

            <label className="checkbox">
              <input
                type="checkbox"
                checked={systemAudioEnabled}
                onChange={(e) => setSystemAudioEnabled(e.target.checked)}
                disabled={displayTargets.length === 0}
              />
              System sound
            </label>
            {!recording && systemAudioEnabled && (
              <div className="mic-meter-track meeting-meter-inline" title={systemAudioPreviewError ?? undefined}>
                <div className="mic-meter-fill" style={{ width: `${Math.min(100, (systemAudioLevel / 160) * 100)}%` }} />
              </div>
            )}
          </div>
        </fieldset>

        <div className="meeting-record-area">
          <button
            type="button"
            className={recording ? "meeting-record-btn recording" : "meeting-record-btn"}
            onClick={recording ? handleStop : handleStart}
            disabled={busy}
            aria-label={recording ? "Stop recording" : "Start recording"}
          >
            {recording ? "■" : "🎙️"}
          </button>
          <span className="muted">{recording ? "Recording…" : busy ? "…" : "Tap to start"}</span>
        </div>

        {recording && <LiveWaveform analyser={analyser} />}

        {error && <p className="error">{error}</p>}

        {savedVideoId && (
          <div className="notice meeting-saved-notice">
            <p>Meeting saved.</p>
            <div className="actions">
              <button type="button" className="primary" onClick={() => navigate("/library")}>
                View in Library
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel meeting-transcript-panel">
        <div className="meeting-transcript-header">
          <h2>Live transcript</h2>
          <button type="button" className="meeting-model-badge" onClick={() => navigate("/settings")} title="Change in Settings > Transcription">
            Model: {WHISPER_MODELS.find((m) => m.size === whisperModel)?.label ?? whisperModel}
          </button>
        </div>
        <div className="meeting-chat">
          {messages.length === 0 && !recording && <p className="muted">Start recording to see a live transcript here.</p>}
          {messages.length === 0 && recording && <p className="muted">Listening…</p>}
          {messages.map((seg, i) => (
            <div key={i} className="meeting-bubble" style={{ borderLeftColor: colorForSpeaker(seg.speaker) }}>
              <span className="meeting-bubble-speaker" style={{ color: colorForSpeaker(seg.speaker) }}>
                {seg.speaker}
              </span>
              <p>{seg.text}</p>
            </div>
          ))}
          {pendingChunks > 0 && <p className="muted meeting-pending">Transcribing…</p>}
        </div>
      </section>
    </div>
  );
}
