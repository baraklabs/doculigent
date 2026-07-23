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

export interface DoculigentApi {
 
  system: {
    platform: string;
    arch: string;
  };
  capture: {
    listTargets(): Promise<CaptureTarget[]>;
  };
  cursor: {
    
    apply(style: CursorHighlightStyle): Promise<void>;
    
    restore(): Promise<void>;
  };
  annotation: {
  
    open(): Promise<void>;
    close(): Promise<void>;
  
    isOpen(): Promise<boolean>;
    getState(): Promise<AnnotationState>;

    setTool(tool: AnnotationTool): Promise<void>;
    setColor(color: string): Promise<void>;
    undo(): Promise<void>;
    redo(): Promise<void>;
    clear(): Promise<void>;
    
    reportHistoryState(canUndo: boolean, canRedo: boolean): Promise<void>;
    onStateChanged(callback: (state: AnnotationState) => void): () => void;
    onCommand(callback: (command: AnnotationCommand) => void): () => void;
    onHistoryStateChanged(callback: (state: { canUndo: boolean; canRedo: boolean }) => void): () => void;
  
    onOverlayOpenChanged(callback: (open: boolean) => void): () => void;
  };
  recording: {
    save(input: {
      webmBytes: ArrayBuffer;
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
    onSaveCompleted(callback: (video: Video) => void): () => void;
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
    /** Tests connectivity/auth for a profile without saving it first — `apiKey` overrides
     *  whatever's already stored, so the form can test as you type. */
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
