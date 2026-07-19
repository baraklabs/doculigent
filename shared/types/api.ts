import type {
  CaptureTarget,
  ChatMessage,
  CursorHighlightStyle,
  LlmModelProfile,
  LlmProviderKind,
  MicConfig,
  OverlayConfig,
  Summary,
  Transcript,
  Video,
} from "./models";
import type { AuthSession, LoginStatus } from "./auth";
import type { AnnotationCommand, AnnotationState, AnnotationTool } from "./annotation";
import type { WhisperModelSize, WhisperModelStatus } from "../constants/whisperModels";

/**
 * The renderer-facing API surface, implemented by the preload script
 * (electron/preload/index.ts) via contextBridge, and backed by ipcMain.handle
 * registrations under electron/main/ipc/*.ts (one function here <-> one IPC channel
 * in shared/constants/channels.ts). This is the single source of truth for the
 * shape of `window.api` — the renderer never talks to ipcRenderer directly.
 */
export interface MusentricApi {
  capture: {
    listTargets(): Promise<CaptureTarget[]>;
  };
  cursor: {
    /** Swaps the real OS mouse cursor for the recording's duration — see
     *  electron/main/native/systemCursor.ts. No-op for "none" and off Windows. */
    apply(style: CursorHighlightStyle): Promise<void>;
    /** Restores whatever the cursor looked like before `apply`; safe to call even if no
     *  override is active. */
    restore(): Promise<void>;
  };
  annotation: {
    /** Opens the system-wide draw overlay — a transparent, click-through-toggling window
     *  spanning every display — see electron/main/annotationWindow.ts. The color/tool/
     *  undo/redo/clear controls live inline in RecordPage, not a second window.
     *  Idempotent: safe to call while already open. */
    open(): Promise<void>;
    /** Closes and destroys the overlay window, discarding any unsaved strokes. */
    close(): Promise<void>;
    /** Whether the overlay is currently open — lets a toggle button reflect reality on
     *  mount even if the overlay was left open from a previous visit to the page. */
    isOpen(): Promise<boolean>;
    /** "pointer" makes the draw window click-through (interact with apps underneath);
     *  any other tool arms it for drawing (captures all mouse input until switched back). */
    setTool(tool: AnnotationTool): Promise<void>;
    setColor(color: string): Promise<void>;
    undo(): Promise<void>;
    redo(): Promise<void>;
    clear(): Promise<void>;
    /** Draw-window renderer -> main, so the embedded toolbar's undo/redo buttons can
     *  reflect whether there's anything to undo/redo. */
    reportHistoryState(canUndo: boolean, canRedo: boolean): Promise<void>;
    /** Pushed to every window whenever the active tool or color changes. */
    onStateChanged(callback: (state: AnnotationState) => void): () => void;
    /** Pushed to the draw window only: an undo/redo/clear button was pressed. */
    onCommand(callback: (command: AnnotationCommand) => void): () => void;
    /** Pushed to every window except the draw window: relayed from reportHistoryState. */
    onHistoryStateChanged(callback: (state: { canUndo: boolean; canRedo: boolean }) => void): () => void;
    /** Pushed to every window except the draw window, whenever the overlay opens or
     *  closes — so a toggle button stays in sync even when closed some other way. */
    onOverlayOpenChanged(callback: (open: boolean) => void): () => void;
  };
  recording: {
    /** Hands a finished WebM recording to the main process: written to disk immediately,
     *  then remuxed to MP4 via ffmpeg and inserted into the library in the background —
     *  that transcode is a real re-encode (not a fast container copy) so it takes real
     *  time, and blocking Stop on it made stopping feel hung. This resolves as soon as
     *  the raw webm write is done; subscribe to onSaveCompleted/onSaveFailed for the
     *  real Video row once the background work finishes. */
    save(input: {
      webmBytes: ArrayBuffer;
      overlay: OverlayConfig;
      durationSecs: number;
      title: string;
      source: "record" | "meeting";
    }): Promise<{ id: string }>;
    /** Meeting tab's audio-only capture — saved as-is (no transcode needed), so this
     *  stays a normal blocking save unlike `save` above. Can carry the transcript
     *  accumulated live during recording so the meeting is already transcribed on save. */
    saveAudio(input: {
      audioBytes: ArrayBuffer;
      durationSecs: number;
      title: string;
      transcript: Transcript | null;
    }): Promise<Video>;
    /** Pushed once the background transcode + library insert from `save` finishes. */
    onSaveCompleted(callback: (video: Video) => void): () => void;
    /** Pushed if the background transcode from `save` fails. */
    onSaveFailed(callback: (failure: { id: string; message: string }) => void): () => void;
  };
  library: {
    list(): Promise<Video[]>;
    get(id: string): Promise<Video | null>;
    delete(id: string): Promise<void>;
    trim(id: string, startSecs: number, endSecs: number): Promise<Video>;
    search(query: string): Promise<Video[]>;
    rename(id: string, title: string): Promise<Video>;
    setTranscript(id: string, transcript: Transcript | null): Promise<Video>;
  };
  settings: {
    getSaveDir(): Promise<string>;
    setSaveDir(dir: string): Promise<void>;
    /** Opens a native folder picker (main-process `dialog.showOpenDialog`); returns
     *  the chosen path, or null if the user cancelled. */
    pickSaveDir(): Promise<string | null>;
    /** Reveals a specific recording's file in the OS file explorer, selected. */
    showItemInFolder(filePath: string): Promise<void>;
    listLlmProfiles(): Promise<LlmModelProfile[]>;
    getActiveLlmProfileId(): Promise<string | null>;
    /** Upserts by `profile.id`. `apiKey` is only written to the OS keychain when given
     *  (non-empty) — omit to leave a previously-saved key untouched. */
    saveLlmProfile(profile: LlmModelProfile, apiKey?: string | null): Promise<void>;
    deleteLlmProfile(id: string): Promise<void>;
    setActiveLlmProfile(id: string): Promise<void>;
    defaultProfileTemplate(kind: LlmProviderKind): Promise<LlmModelProfile>;
    /** Last-used Record tab settings (camera overlay + capture source + mic), null fields
     *  when nothing's been saved yet (first run). */
    getRecordSettings(): Promise<{ overlay: OverlayConfig | null; targetId: string | null; mic: MicConfig | null }>;
    setRecordSettings(overlay: OverlayConfig, targetId: string | null, mic: MicConfig | null): Promise<void>;
    /** Last-used Meeting tab settings (language + both audio sources), null fields when
     *  nothing's been saved yet (first run — the Meeting tab defaults both sources on). */
    getMeetingSettings(): Promise<{
      language: string | null;
      micEnabled: boolean | null;
      micDeviceId: string | null;
      systemAudioEnabled: boolean | null;
      systemAudioSourceId: string | null;
    }>;
    setMeetingSettings(
      language: string,
      micEnabled: boolean,
      micDeviceId: string | null,
      systemAudioEnabled: boolean,
      systemAudioSourceId: string | null
    ): Promise<void>;
    getWhisperModel(): Promise<WhisperModelSize>;
    setWhisperModel(size: WhisperModelSize): Promise<void>;
    /** Which model sizes have their files on disk already, and how big each is. */
    getWhisperModelStatuses(): Promise<WhisperModelStatus[]>;
    /** Forces a model's download/load now instead of waiting for the next live segment. */
    downloadWhisperModel(size: WhisperModelSize): Promise<void>;
    deleteWhisperModel(size: WhisperModelSize): Promise<void>;
    getWhisperModelsDir(): Promise<string>;
    openWhisperModelsDir(): Promise<void>;
  };
  ai: {
    /** Uses the active profile unless `profileId` is given (per-session override, e.g.
     *  from the AI Assistant tab's model picker). */
    summarize(transcript: Transcript, profileId?: string): Promise<Summary>;
    chat(transcript: Transcript, history: ChatMessage[], question: string, profileId?: string): Promise<ChatMessage>;
    /** Tests connectivity/auth for a profile without saving it first — `apiKey` overrides
     *  whatever's already stored, so the form can test as you type. */
    testConnection(profile: LlmModelProfile, apiKey?: string | null): Promise<{ ok: boolean; message: string }>;
  };
  transcription: {
    /** `language`: a Whisper language code (see shared/constants/languages.ts), or "auto"/
     *  omitted to let Whisper detect it. `modelSize`: overrides the Settings >
     *  Transcription default for just this call (the Library transcript drawer's
     *  re-transcribe picker). */
    transcribe(filePath: string, language?: string, modelSize?: WhisperModelSize): Promise<Transcript>;
    /** Transcribes one already-decoded 16kHz mono PCM chunk (a Meeting tab live-recording
     *  segment) — samples as a plain number[] to keep the contextBridge crossing simple
     *  rather than relying on TypedArray clone support. */
    transcribePcm(samples: number[], language?: string): Promise<Transcript>;
    /** Stops whatever transcription is currently in flight (file or live-chunk) — see
     *  Channels.transcription.cancel. The in-flight transcribe() call rejects as a result;
     *  callers should treat that rejection as a cancellation, not a real failure. */
    cancel(): Promise<void>;
  };
  window: {
    /** The window is frameless (see electron/main/window.ts) — the custom topbar is the
     *  drag handle, and these back its minimize/close buttons since there's no native
     *  title bar chrome to provide them anymore. */
    minimize(): Promise<void>;
    close(): Promise<void>;
  };
  auth: {
    /** Currently signed-in doculigent.com account, or null if signed out. */
    getSession(): Promise<AuthSession | null>;
    /** Starts a PKCE login: opens the system browser to doculigent.com, then resolves once
     *  the code comes back — either via the loopback redirect or `submitManualCode`. */
    login(): Promise<AuthSession>;
    /** Fallback for when the browser can't reach the loopback redirect: doculigent.com
     *  shows the code on-page for the user to paste in manually. Completes whichever
     *  `login()` call is currently in flight. */
    submitManualCode(code: string): Promise<void>;
    cancelLogin(): Promise<void>;
    logout(): Promise<void>;
    /** Dev-only: instantly "signs in" with a fake local account, no network involved.
     *  Rejects outside development builds — see electron/main/auth/doculigentAuth.ts. */
    devLogin(): Promise<AuthSession>;
    /** Pushed whenever the session or an in-flight login's status changes. Returns an
     *  unsubscribe function. */
    onSessionChanged(callback: (session: AuthSession | null, loginStatus: LoginStatus) => void): () => void;
  };
}
