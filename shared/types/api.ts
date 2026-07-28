import type {
  CaptureTarget,
  ChatMessage,
  CursorHighlightStyle,
  EditProject,
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

export interface DoculigentApi {
 
  system: {
    platform: string;
    arch: string;
    getPathForFile(file: File): string;
  };
  capture: {
    listTargets(): Promise<CaptureTarget[]>;
  };
  cursor: {

    apply(style: CursorHighlightStyle): Promise<void>;

    restore(): Promise<void>;
    /** Starts sampling pointer positions for the cursor metadata sidecar. */
    startCapture(targetId: string, style: CursorHighlightStyle): Promise<void>;
    /** Stops sampling; the track stays buffered until recording.save writes it out. */
    stopCapture(): Promise<void>;
  };
  screenCapture: {
    /** Starts a Windows gdigrab capture of the given display target directly to a temp
     *  file, with the real cursor excluded from the frames when `hideCursor` is true —
     *  the real pointer itself is never touched. Resolves `available: false` (not an
     *  error) whenever this path doesn't apply: non-Windows, or a specific-window target
     *  rather than a whole display, or a capture is already running. Callers fall back to
     *  the ordinary getUserMedia/MediaRecorder pipeline in that case. */
    start(targetId: string, hideCursor: boolean): Promise<{ available: boolean }>;
    /** Stops the capture and returns the finished file's path. `available: false` mirrors
     *  start()'s meaning — nothing was running to stop. */
    stop(): Promise<{ available: boolean; filePath?: string }>;
  };
  annotation: {
  
    open(): Promise<void>;

    isOpen(): Promise<boolean>;
    getState(): Promise<AnnotationState>;

    setTool(tool: AnnotationTool): Promise<void>;
    setColor(color: string): Promise<void>;
    setWidth(width: number): Promise<void>;
    setOpacity(opacity: number): Promise<void>;
    setFadeMs(fadeMs: number): Promise<void>;
    undo(): Promise<void>;
    redo(): Promise<void>;
    clear(): Promise<void>;
    
    reportHistoryState(canUndo: boolean, canRedo: boolean): Promise<void>;
    setStrokeActive(active: boolean): Promise<void>;
    onStateChanged(callback: (state: AnnotationState) => void): () => void;
    onCommand(callback: (command: AnnotationCommand) => void): () => void;
    onHistoryStateChanged(callback: (state: { canUndo: boolean; canRedo: boolean }) => void): () => void;
  
    onOverlayOpenChanged(callback: (open: boolean) => void): () => void;
  };
  recording: {
    /** Exactly one of `webmBytes` (ordinary getUserMedia/MediaRecorder pipeline) or
     *  `screenFilePath` (native gdigrab pipeline, screen already on disk) is set, matching
     *  whichever RecordingService used for this recording. `sideClip` is the camera-bubble
     *  or mic-only clip recorded alongside a native screen capture, if any — see
     *  electron/main/ipc/recording.ts for how the two get combined. */
    save(input: {
      webmBytes?: ArrayBuffer;
      screenFilePath?: string;
      sideClip?: { bytes: ArrayBuffer; hasVideo: boolean; hasAudio: boolean };
      overlay: OverlayConfig;
      durationSecs: number;
      title: string;
      source: "record" | "meeting";
    }): Promise<{ id: string }>;
    saveAudio(input: {
      audioBytes: ArrayBuffer;
      durationSecs: number;
      title: string;
      transcript: Transcript | null;
    }): Promise<Video>;
    onSaveProgress(callback: (progress: { id: string; percent: number }) => void): () => void;
    cancelSave(id: string): Promise<boolean>;
    onSaveCompleted(callback: (video: Video) => void): () => void;
    onSaveFailed(callback: (failure: { id: string; message: string }) => void): () => void;
  };
  library: {
    list(): Promise<Video[]>;
    get(id: string): Promise<Video | null>;
    delete(id: string, keepFile?: boolean): Promise<void>;
    deleteMany(ids: string[], keepFile?: boolean): Promise<void>;
    search(query: string): Promise<Video[]>;
    rename(id: string, title: string): Promise<Video>;
    setTranscript(id: string, transcript: Transcript | null): Promise<Video>;
  };
  editProjects: {
    list(): Promise<EditProject[]>;
    get(id: string): Promise<EditProject | null>;
    create(input: {
      name: string;
      sourceFilePath: string;
      sourceKind: "video" | "audio";
      sourceVideoId: string | null;
      durationSecs: number;
    }): Promise<EditProject>;
    update(
      id: string,
      patch: Partial<Pick<EditProject, "name" | "sourceFilePath" | "trimStart" | "trimEnd" | "cuts">>
    ): Promise<EditProject>;
    delete(id: string): Promise<void>;
   
    pickImportFile(): Promise<string | null>;
    fileExists(filePath: string): Promise<boolean>;
    export(id: string, keepRanges: [number, number][]): Promise<{ outputPath: string }>;
  };
  settings: {
    getSaveDir(): Promise<string>;
    setSaveDir(dir: string): Promise<void>;
    pickSaveDir(): Promise<string | null>;
    showItemInFolder(filePath: string): Promise<void>;
    listLlmProfiles(): Promise<LlmModelProfile[]>;
    getActiveLlmProfileId(): Promise<string | null>;
    saveLlmProfile(profile: LlmModelProfile, apiKey?: string | null): Promise<void>;
    deleteLlmProfile(id: string): Promise<void>;
    setActiveLlmProfile(id: string): Promise<void>;
    defaultProfileTemplate(kind: LlmProviderKind): Promise<LlmModelProfile>;
    getRecordSettings(): Promise<{ overlay: OverlayConfig | null; targetId: string | null; mic: MicConfig | null }>;
    setRecordSettings(overlay: OverlayConfig, targetId: string | null, mic: MicConfig | null): Promise<void>;
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
    getWhisperModelStatuses(): Promise<WhisperModelStatus[]>;
    downloadWhisperModel(size: WhisperModelSize): Promise<void>;
    deleteWhisperModel(size: WhisperModelSize): Promise<void>;
    getWhisperModelsDir(): Promise<string>;
    openWhisperModelsDir(): Promise<void>;
  };
  ai: {
    summarize(transcript: Transcript, profileId?: string): Promise<Summary>;
    chat(transcript: Transcript, history: ChatMessage[], question: string, profileId?: string): Promise<ChatMessage>;
    testConnection(profile: LlmModelProfile, apiKey?: string | null): Promise<{ ok: boolean; message: string }>;
  };
  transcription: {
    transcribe(filePath: string, language?: string, modelSize?: WhisperModelSize): Promise<Transcript>;
    transcribePcm(samples: number[], language?: string): Promise<Transcript>;
    cancel(): Promise<void>;
  };
  window: {
    minimize(): Promise<void>;
    close(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    isMaximized(): Promise<boolean>;
    onMaximizeChanged(callback: (maximized: boolean) => void): () => void;
  };
  auth: {
    getSession(): Promise<AuthSession | null>;
    login(): Promise<AuthSession>;
    submitManualCode(code: string): Promise<void>;
    cancelLogin(): Promise<void>;
    logout(): Promise<void>;
    onSessionChanged(callback: (session: AuthSession | null, loginStatus: LoginStatus) => void): () => void;
  };
}
