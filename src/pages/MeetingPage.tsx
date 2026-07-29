import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Headphones, Globe, FileText, Mic, Square, Pause, Play } from "lucide-react";
import type { CaptureTarget, TranscriptSegment } from "@shared/types/models";
import { DEFAULT_TRANSCRIPTION_LANGUAGE, TRANSCRIPTION_LANGUAGES } from "@shared/constants/languages";
import type { WhisperModelSize } from "@shared/constants/whisperModels";
import { WHISPER_MODELS } from "@shared/constants/whisperModels";
import { isBilledTier } from "@shared/constants/plans";
import { audioRecordingService, getSystemAudioStream } from "../services/recording/AudioRecordingService";
import { TranscriptionService } from "../services/transcription/TranscriptionService";
import { SettingsService } from "../services/settings/SettingsService";
import { useAuthStore } from "../store/authStore";
import { useMeetingRecordingStore } from "../store/meetingRecordingStore";
import { useLlmProfiles } from "../hooks/useLlmProfiles";
import { LiveWaveform } from "../components/LiveWaveform";
import { useToast } from "../hooks/useToast";
import "./MeetingPage.css";

const SPEAKER_COLORS = ["#5b4bf5", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444"];
function colorForSpeaker(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return SPEAKER_COLORS[hash % SPEAKER_COLORS.length];
}

function formatTimestamp(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** "0:04–0:08" — the segment's time window within this meeting, not wall-clock time. */
function formatTimeWindow(start: number, end: number): string {
  return `${formatTimestamp(start)}–${formatTimestamp(end)}`;
}

/** "Untitled 29-07-26 11:23" — the default meeting title, timestamped so a batch of
 *  never-renamed meetings in the Library are still distinguishable from each other instead
 *  of all reading as the same "Untitled meeting". */
function defaultMeetingTitle(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const dd = pad(now.getDate());
  const mm = pad(now.getMonth() + 1);
  const yy = pad(now.getFullYear() % 100);
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  return `Meeting ${dd}-${mm}-${yy} ${hh}:${min}`;
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
  const [title, setTitle] = useState(() => defaultMeetingTitle());
  const [language, setLanguage] = useState(DEFAULT_TRANSCRIPTION_LANGUAGE);
  // Both sources default on, matching "just works" expectations — restored from the last
  // saved choice below once that loads, same pattern as RecordPage's overlay/mic restore.
  const [micEnabled, setMicEnabled] = useState(true);
  const [micDeviceId, setMicDeviceId] = useState<string | null>(null);
  const [systemAudioEnabled, setSystemAudioEnabled] = useState(true);
  const [systemAudioSourceId, setSystemAudioSourceId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  // Mirrors `recording` into the global store so Layout.tsx can lock tab navigation while
  // a meeting is being recorded — see meetingRecordingStore.ts for why that's needed (the
  // capture itself doesn't survive this page unmounting, unlike Record's). The cleanup
  // clears the flag if this instance unmounts for any other reason (e.g. dev hot-reload),
  // so it can never get stuck locked with no page left to unlock it.
  const setMeetingRecordingFlag = useMeetingRecordingStore((s) => s.setRecording);
  useEffect(() => {
    setMeetingRecordingFlag(recording);
  }, [recording, setMeetingRecordingFlag]);
  useEffect(() => () => setMeetingRecordingFlag(false), [setMeetingRecordingFlag]);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [messages, setMessages] = useState<TranscriptSegment[]>([]);
  const [pendingChunks, setPendingChunks] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Drives the small Summarize/Generate Notes/Quick Chat popup above the dock — stays up
  // until manually dismissed (or one of its actions is taken) rather than auto-expiring,
  // since acting on a just-finished meeting isn't something to rush.
  const [savedVideoId, setSavedVideoId] = useState<string | null>(null);
  // The separate "Meeting saved / Go to Library" corner toast, same as before — still
  // auto-dismisses after a while (same duration as the app-wide toast system's default,
  // see toastStore.ts's DEFAULT_TOAST_DURATION) since it's just a confirmation + a
  // navigation shortcut, not something that needs to stick around.
  const [showSavedToast, setShowSavedToast] = useState(false);
  useEffect(() => {
    if (!showSavedToast) return;
    const timer = setTimeout(() => setShowSavedToast(false), 5000);
    return () => clearTimeout(timer);
  }, [showSavedToast]);

  // Which Whisper model size transcribes — chosen right here (see the picker below), not
  // in Settings (which only downloads/removes files, see SettingsPage.tsx). Persisted so
  // it's remembered as the last-used choice across sessions; re-fetched on mount so a
  // model downloaded/removed in Settings is reflected next time this tab is opened.
  const [whisperModel, setWhisperModelState] = useState<WhisperModelSize | null>(null);
  const [downloadedModels, setDownloadedModels] = useState<typeof WHISPER_MODELS>([]);
  // Whether the picker is set to the (not yet implemented) hosted Doculigent Model rather
  // than a local size — persisted separately from whisperModel (see settingsStore.ts's
  // getUseDoculigentModel) so the last local choice underneath survives signing out or
  // downgrading. Gated live off the account's own plan rather than trusted at face value,
  // so a downgrade/sign-out takes effect immediately without needing to touch this flag.
  const [useDoculigent, setUseDoculigent] = useState(false);
  const session = useAuthStore((s) => s.session);
  const cloudEnabled = !!session?.user.plan && isBilledTier(session.user.plan.tier);
  const usingCloud = useDoculigent && cloudEnabled;

  // BYOK (bring-your-own-key) transcription endpoints, configured in Settings >
  // Transcription (see SettingsPage.tsx's BYOK cards) — a "custom" LLM profile tagged with
  // the "transcribe" capability. Selected by id (see settingsStore.ts's
  // getTranscriptionByokProfileId) rather than trusted blindly, since the profile could
  // have been deleted or had "transcribe" unchecked since it was picked here.
  const { data: llmProfiles = [] } = useLlmProfiles();
  const byokProfiles = llmProfiles.filter((p) => p.capabilities.includes("transcribe"));
  const [byokProfileId, setByokProfileIdState] = useState<string | null>(null);
  const usingByok = byokProfileId !== null && byokProfiles.some((p) => p.id === byokProfileId);

  // Doculigent Model has no backend yet (see whisper.ts), so it never counts as ready —
  // BYOK does actually call out to the configured endpoint (see whisper.ts's
  // resolveByokProfile), so it's ready as soon as a valid profile is selected.
  const modelReady =
    !usingCloud && (usingByok || (whisperModel !== null && downloadedModels.some((m) => m.size === whisperModel)));

  useEffect(() => {
    Promise.all([
      SettingsService.getWhisperModel(),
      SettingsService.getWhisperModelStatuses(),
      SettingsService.getUseDoculigentModel(),
      SettingsService.getTranscriptionByokProfileId(),
    ])
      .then(([lastUsed, statuses, useCloud, byokId]) => {
        setUseDoculigent(useCloud);
        setByokProfileIdState(byokId);
        // A download in progress writes its files incrementally, so `downloaded` (any
        // bytes on disk) can go true before it's actually finished — exclude that case
        // the same way whisper.ts's requireDownloadedModel does on the main-process side.
        const downloaded = WHISPER_MODELS.filter((m) => {
          const status = statuses.find((s) => s.size === m.size);
          return status?.downloaded && !status.downloading;
        });
        setDownloadedModels(downloaded);
        if (lastUsed !== null && downloaded.some((m) => m.size === lastUsed)) {
          setWhisperModelState(lastUsed);
        } else if (downloaded.length > 0) {
          // No usable last-used choice (never picked one, or it's since been removed in
          // Settings) — default to whichever size is downloaded rather than leaving the
          // picker on nothing, and persist that as the new last-used choice.
          setWhisperModelState(downloaded[0].size);
          SettingsService.setWhisperModel(downloaded[0].size).catch(() => { });
        } else {
          setWhisperModelState(null);
        }
      })
      .catch(() => { });
  }, []);

  async function handleModelChange(size: WhisperModelSize) {
    setWhisperModelState(size);
    await SettingsService.setWhisperModel(size);
  }

  async function handleModelSelectChange(value: string) {
    if (value === "doculigent") {
      setUseDoculigent(true);
      setByokProfileIdState(null);
      await Promise.all([
        SettingsService.setUseDoculigentModel(true),
        SettingsService.setTranscriptionByokProfileId(null),
      ]);
    } else if (value.startsWith("byok:")) {
      const id = value.slice("byok:".length);
      setUseDoculigent(false);
      setByokProfileIdState(id);
      await Promise.all([
        SettingsService.setUseDoculigentModel(false),
        SettingsService.setTranscriptionByokProfileId(id),
      ]);
    } else {
      setUseDoculigent(false);
      setByokProfileIdState(null);
      await Promise.all([
        SettingsService.setUseDoculigentModel(false),
        SettingsService.setTranscriptionByokProfileId(null),
      ]);
      await handleModelChange(value as WhisperModelSize);
    }
  }

  // Which settings popup is open, if any — Meeting details/Audio sources/Language/Model
  // used to be always-visible panels; they're now tucked behind the icon bar below the
  // record button, each opening this same modal shell with different content.
  const [activeModal, setActiveModal] = useState<"details" | "audio" | "language" | "model" | null>(null);

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

  // A transient warning toast each time the mic gets turned off — stacking/auto-dismiss is
  // handled by the shared toast system (see useToast) instead of hand-rolled here.
  //
  // Only for choices made *this session*: without micWarningInitialized, restoring a
  // previously-saved "mic off" on mount (or just navigating back to this tab, which
  // remounts it) would flip micEnabled true->false right as settings load and trigger the
  // same toast as an actual user toggle — this skips exactly that first post-load run.
  const toast = useToast();
  const micWarningInitialized = useRef(false);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!micWarningInitialized.current) {
      micWarningInitialized.current = true;
      return;
    }
    if (!micEnabled) {
      toast.warning(
        "If you record like this, your voice won't be picked up at all. Only the other side of the " +
          "conversation (whatever the enabled sources actually hear, e.g. system sound) will be recorded and " +
          "transcribed.",
        { title: "Microphone is off" }
      );
    }
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

  // Auto-scrolls the transcript feed to the newest line as segments/pending-indicator
  // arrive, so the control dock docking to the bottom (see isActive below) doesn't leave
  // the reader stuck looking at an old scroll position above the fold.
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pendingChunks]);

  async function handleSegment(samples: Float32Array, offsetSecs: number) {
    // No model downloaded yet — recording still captures full audio (see handleStop),
    // just skip live transcription rather than silently kicking off a first-use
    // download mid-meeting. The transcript panel below tells the user why.
    if (!modelReady) return;
    if (pendingRef.current > 0) return;
    pendingRef.current++;
    setPendingChunks((n) => n + 1);
    try {
      const transcript = await TranscriptionService.transcribePcm(samples, language);
      if (transcript.segments.length > 0) {
        // Whisper timestamps each segment relative to the ~4s rolling clip it was given
        // (see AudioRecordingService), not the meeting as a whole — offsetSecs (how far
        // into the recorded meeting this clip started, pauses excluded) shifts them back
        // onto the meeting's own timeline so they don't all read as starting at 0:00.
        const shifted = transcript.segments.map((seg) => ({
          ...seg,
          start: seg.start + offsetSecs,
          end: seg.end + offsetSecs,
        }));
        setMessages((prev) => [...prev, ...shifted]);
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
    setShowSavedToast(false);
    try {
      const node = await audioRecordingService.start(handleSegment, {
        mic: { enabled: micEnabled, deviceId: micDeviceId },
        systemAudio: { enabled: systemAudioEnabled, sourceId: systemAudioSourceId },
      });
      setAnalyser(node);
      setRecording(true);
      setPaused(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Pauses/resumes both the saved recording and the live-transcription segments (see
  // AudioRecordingService's pause/resume) — mic/system audio stay connected throughout, so
  // the waveform keeps moving; only the write to the eventual file (and new segments)
  // stops for the paused window.
  function handlePauseResume() {
    if (paused) {
      audioRecordingService.resume();
      setPaused(false);
    } else {
      audioRecordingService.pause();
      setPaused(true);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      const { blob, durationSecs } = await audioRecordingService.stop();
      setRecording(false);
      setPaused(false);
      setAnalyser(null);

      const audioBytes = await blob.arrayBuffer();
      const transcript = messages.length > 0 ? { language, engine: "whisper-local" as const, segments: messages } : null;
      const saved = await window.api.recording.saveAudio({ audioBytes, durationSecs, title, transcript });
      setSavedVideoId(saved.id);
      setShowSavedToast(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Once a meeting has actually started (or has a transcript to show), the transcript
  // feed takes over the available space above the control dock instead of sitting empty —
  // the dock itself stays pinned to the bottom either way now (see .meeting-main-panel;
  // the record button no longer jumps from vertically-centered to bottom-docked once you
  // start recording, it's always in the same place).
  const isActive = recording || messages.length > 0;

  const modalTitles: Record<NonNullable<typeof activeModal>, string> = {
    details: "Meeting details",
    audio: "Audio sources",
    language: "Language",
    model: "Transcription model",
  };

  // What's currently set for each of the four settings, shown right on their trigger
  // button instead of only inside the modal — so you can see at a glance whether e.g. a
  // transcription model is actually configured without having to open anything.
  const modelSummary = usingCloud
    ? "Doculigent Model"
    : usingByok
      ? byokProfiles.find((p) => p.id === byokProfileId)?.name || "BYOK"
      : whisperModel
        ? (WHISPER_MODELS.find((m) => m.size === whisperModel)?.label ?? whisperModel)
        : "Not set — tap to set";
  const audioSummary =
    micEnabled && systemAudioEnabled
      ? "Mic + System"
      : micEnabled
        ? "Mic only"
        : systemAudioEnabled
          ? "System only"
          : "Not set — tap to set";
  const languageSummary = TRANSCRIPTION_LANGUAGES.find((l) => l.code === language)?.label ?? language;

  return (
    <div className="meeting-page-v2">
      <section className={`panel meeting-main-panel${isActive ? " active" : ""}`}>
        <div className="meeting-transcript-area" ref={transcriptRef}>
          {/* margin-top: auto (see CSS) pushes this whole block to the bottom of the
              scroll container when it's shorter than the available space, without the
              justify-content: flex-end + overflow-y: auto combination that was flickering
              the scrollbar and making the content unreliably scrollable. */}
          <div className="meeting-transcript-content">
            {!modelReady && recording && (
              <p className="muted">
                {usingCloud
                  ? "The Doculigent Model isn't available yet — only audio is being recorded for now."
                  : "Only audio is being recorded — live transcription will be available once you set up a transcription model in Settings."}
              </p>
            )}
            {messages.length === 0 && recording && modelReady && <p className="muted meeting-listening">Listening…</p>}
            {messages.map((seg, i) => (
              <div key={i} className="meeting-bubble" style={{ borderLeftColor: colorForSpeaker(seg.speaker) }}>
                <span className="meeting-bubble-time">{formatTimeWindow(seg.start, seg.end)}</span>
                <p>{seg.text}</p>
              </div>
            ))}
            {pendingChunks > 0 && <p className="muted meeting-pending">Transcribing…</p>}
          </div>
        </div>

        {/* Small individual pills right above the control dock, instead of a corner toast —
            stay up until one is clicked (or a new recording starts, see handleStart) rather
            than auto-expiring after a few seconds or needing an explicit close button.
            "Go to Library" isn't here — that lives in the separate auto-dismissing corner
            toast below, same as before. Summarize/Generate Notes carry a pending action
            that auto-fires once the AI Assistant tab's attachment finishes loading there
            (see AiAssistantPage.tsx); Quick Chat just opens the attachment for typing. */}
        {savedVideoId && (
          <div className="meeting-saved-popup">
            <button
              type="button"
              onClick={() => {
                setSavedVideoId(null);
                navigate("/ai", { state: { videoId: savedVideoId, action: "summarize" } });
              }}
            >
              Summarize
            </button>
            <button
              type="button"
              onClick={() => {
                setSavedVideoId(null);
                navigate("/ai", { state: { videoId: savedVideoId, action: "notes" } });
              }}
            >
              Generate Notes
            </button>
            <button
              type="button"
              onClick={() => {
                setSavedVideoId(null);
                navigate("/ai", { state: { videoId: savedVideoId } });
              }}
            >
              Quick Chat
            </button>
          </div>
        )}

        {error && <p className="error meeting-error">{error}</p>}

        {/* One row, in order: Model, Audio, the record button (always in the same spot,
            whether idle or recording — see .meeting-control-dock), Language, Details.
            Each setting button shows its current value (modelSummary/audioSummary/
            languageSummary/title) rather than just a label, so what's set is visible
            without opening its modal. */}
        <div className="meeting-dock-row">
          <button type="button" className="meeting-side-btn" onClick={() => setActiveModal("model")}>
            <span className="meeting-side-btn-head">
              <Bot size={16} /> Model
            </span>
            <span className="meeting-side-btn-value">{modelSummary}</span>
          </button>
          <button type="button" className="meeting-side-btn" onClick={() => setActiveModal("audio")}>
            <span className="meeting-side-btn-head">
              <Headphones size={16} /> Audio
            </span>
            <span className="meeting-side-btn-value">{audioSummary}</span>
          </button>

          <div className="meeting-control-dock">
            {!recording ? (
              <div className="meeting-record-area">
                <button type="button" className="meeting-record-btn" onClick={handleStart} disabled={busy} aria-label="Start recording">
                  <Mic size={36} />
                </button>
                <span className="muted">{busy ? "…" : "Tap to start"}</span>
              </div>
            ) : (
              <div className="meeting-record-area">
                <div className="meeting-toolbar-controls">
                  <button
                    type="button"
                    className="meeting-pause-btn"
                    onClick={handlePauseResume}
                    disabled={busy}
                    aria-label={paused ? "Resume recording" : "Pause recording"}
                    title={paused ? "Resume" : "Pause"}
                  >
                    {paused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
                  </button>
                  <button
                    type="button"
                    className={`meeting-pause-btn meeting-stop-btn${paused ? " paused" : ""}`}
                    onClick={handleStop}
                    disabled={busy}
                    aria-label="Stop recording"
                    title="Stop"
                  >
                    <Square size={16} fill="currentColor" />
                  </button>
                </div>
                <span className="muted">{paused ? "Paused" : "Recording…"}</span>
              </div>
            )}

            {/* Absolutely positioned behind the record controls (see .live-waveform's
                position: absolute) rather than a normal sibling in flow — an in-flow
                waveform was adding height to this row every time recording started,
                which (combined with .meeting-dock-row's centering) nudged the record
                button — and the Model/Audio/Language/Details buttons centered against
                it — upward each time. Absolute positioning removes it from the layout
                entirely, so nothing else ever moves because of it. */}
            {recording && <LiveWaveform analyser={analyser} />}
          </div>

          <button type="button" className="meeting-side-btn" onClick={() => setActiveModal("language")}>
            <span className="meeting-side-btn-head">
              <Globe size={16} /> Language
            </span>
            <span className="meeting-side-btn-value">{languageSummary}</span>
          </button>
          <button type="button" className="meeting-side-btn" onClick={() => setActiveModal("details")}>
            <span className="meeting-side-btn-head">
              <FileText size={16} /> Details
            </span>
            <span className="meeting-side-btn-value">{title || "Not set — tap to set"}</span>
          </button>
        </div>
      </section>

      {activeModal && (
        <div className="modal-backdrop" onClick={() => setActiveModal(null)}>
          <div className="modal meeting-settings-modal" onClick={(e) => e.stopPropagation()}>
            <div className="transcript-drawer-header">
              <h2>{modalTitles[activeModal]}</h2>
              <button type="button" className="icon-btn" title="Close" onClick={() => setActiveModal(null)}>
                ✕
              </button>
            </div>

            {activeModal === "details" && (
              <div className="meeting-modal-fields">
                <label className="field">
                  <span>Title</span>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={recording || busy}
                  />
                </label>

                <label className="field">
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
              </div>
            )}

            {activeModal === "language" && (
              <div className="meeting-modal-fields">
                <label className="field">
                  <span>Transcription language</span>
                  <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={recording || busy}>
                    {TRANSCRIPTION_LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {activeModal === "audio" && (
              <fieldset className="meeting-modal-fields" disabled={recording || busy}>
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
                </div>

                <div className="meeting-source-row">
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
            )}

            {activeModal === "model" && (
              <div className="meeting-modal-fields">
                {downloadedModels.length > 0 || cloudEnabled || byokProfiles.length > 0 ? (
                  <label className="field">
                    <span>Transcription model</span>
                    <select
                      value={usingCloud ? "doculigent" : usingByok ? `byok:${byokProfileId}` : (whisperModel ?? "")}
                      onChange={(e) => handleModelSelectChange(e.target.value)}
                      disabled={recording || busy}
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
                  </label>
                ) : (
                  <div className="meeting-model-empty">
                    <p className="muted">No transcription model is set up yet.</p>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        setActiveModal(null);
                        navigate("/settings");
                      }}
                    >
                      Set up in Settings
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="actions modal-actions">
              <button type="button" className="primary" onClick={() => setActiveModal(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {showSavedToast && savedVideoId && (
        <div className="toast toast-success">
          <button type="button" className="toast-close" onClick={() => setShowSavedToast(false)} aria-label="Dismiss">
            ×
          </button>
          <strong>Meeting saved</strong>
          <p className="muted toast-path">You can view and edit it from your Library.</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                setShowSavedToast(false);
                navigate("/library?section=meeting");
              }}
            >
              Go to Library
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
