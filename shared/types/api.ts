import type {
  AppIntegration,
  AppIntegrationKind,
  AutoTranscribeSettings,
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
import type { FileDownloadTicket, Team, TeamFile, TeamFileStatus, TeamMember } from "./team";
import type { PmRunResult, ProjectManager } from "./projectManager";
import type { CustomPersona } from "./persona";
import type { ShareLink, StorageFile, StoragePreference, StorageTeam } from "./storage";

export interface DoculigentApi {
 
  system: {
    platform: string;
    arch: string;
    getPathForFile(file: File): string;
  };
  capture: {
    listTargets(): Promise<CaptureTarget[]>;
    // macOS-only: reflects TCC (Privacy & Security) access. Always "granted" on other platforms.
    getPermissionStatus(): Promise<{
      screen: "not-determined" | "granted" | "denied" | "restricted" | "unknown";
      microphone: "not-determined" | "granted" | "denied" | "restricted" | "unknown";
    }>;
    openScreenRecordingSettings(): Promise<void>;
  };
  cursor: {

    apply(style: CursorHighlightStyle): Promise<void>;

    restore(): Promise<void>;
    startCapture(targetId: string, style: CursorHighlightStyle): Promise<void>;
    stopCapture(): Promise<void>;
  };
  screenCapture: {
    start(targetId: string, hideCursor: boolean): Promise<{ available: boolean }>;
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
    pickFiles(kind: "video" | "audio", multi?: boolean): Promise<string[]>;
    importFiles(filePaths: string[], kind: "video" | "audio"): Promise<Video[]>;
    onImportProgress(callback: (progress: { percent: number; fileIndex: number; totalFiles: number }) => void): () => void;
  };
  settings: {
    getSaveDir(): Promise<string>;
    setSaveDir(dir: string): Promise<void>;
    pickSaveDir(): Promise<string | null>;
    showItemInFolder(filePath: string): Promise<void>;
    listLlmProfiles(): Promise<LlmModelProfile[]>;
    saveLlmProfile(profile: LlmModelProfile, apiKey?: string | null): Promise<void>;
    deleteLlmProfile(id: string): Promise<void>;
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
    getWhisperModel(): Promise<WhisperModelSize | null>;
    setWhisperModel(size: WhisperModelSize | null): Promise<void>;
    getWhisperModelStatuses(): Promise<WhisperModelStatus[]>;
    downloadWhisperModel(size: WhisperModelSize): Promise<void>;
    deleteWhisperModel(size: WhisperModelSize): Promise<void>;
    getWhisperModelsDir(): Promise<string>;
    openWhisperModelsDir(): Promise<void>;
    getUseDoculigentModel(): Promise<boolean>;
    setUseDoculigentModel(use: boolean): Promise<void>;
    getTranscriptionByokProfileId(): Promise<string | null>;
    setTranscriptionByokProfileId(id: string | null): Promise<void>;
    getAutoTranscribeSettings(): Promise<AutoTranscribeSettings>;
    setAutoTranscribeSettings(settings: AutoTranscribeSettings): Promise<void>;
  };
  ai: {
    summarize(transcript: Transcript, profileId?: string): Promise<Summary>;
    chat(
      transcript: Transcript | null,
      history: ChatMessage[],
      question: string,
      profileId?: string,
      systemPromptOverride?: string
    ): Promise<ChatMessage>;
    testConnection(profile: LlmModelProfile, apiKey?: string | null): Promise<{ ok: boolean; message: string }>;
  };
  apps: {
    list(): Promise<AppIntegration[]>;
    save(integration: AppIntegration, secret?: string | null): Promise<void>;
    delete(id: string): Promise<void>;
    testConnection(
      kind: AppIntegrationKind,
      integrationId: string | null,
      secret?: string | null
    ): Promise<{ ok: boolean; message: string }>;
    githubCreateIssue(
      integrationId: string,
      repo: string,
      title: string,
      body: string
    ): Promise<{ ok: boolean; message: string; url?: string }>;
    githubCommentIssue(
      integrationId: string,
      repo: string,
      issueNumber: number,
      body: string
    ): Promise<{ ok: boolean; message: string; url?: string }>;
    slackPostMessage(integrationId: string, channel: string, text: string): Promise<{ ok: boolean; message: string }>;
  };
  transcription: {
    transcribe(filePath: string, language?: string, modelSize?: WhisperModelSize, byokProfileId?: string): Promise<Transcript>;
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
  teams: {
    create(name: string): Promise<Team>;
    list(): Promise<Team[]>;
    get(teamId: string): Promise<{ team: Team; members: TeamMember[]; files: TeamFile[] }>;
    inviteMember(teamId: string, email: string): Promise<TeamMember>;
    removeMember(teamId: string, memberId: string): Promise<void>;
    delete(teamId: string): Promise<void>;
    listFiles(teamId: string, status?: TeamFileStatus): Promise<TeamFile[]>;
    presignDownload(fileId: string): Promise<FileDownloadTicket>;
    setFileStatus(fileId: string, status: TeamFileStatus): Promise<TeamFile>;
    permanentlyDeleteFile(fileId: string): Promise<void>;
    uploadFile(uploadId: string, teamId: string, filePath: string, displayName?: string): Promise<TeamFile>;
    onUploadProgress(callback: (progress: { uploadId: string; percent: number }) => void): () => void;
    downloadToLibrary(teamId: string, fileId: string): Promise<Video>;
    listSyncedFileIds(): Promise<string[]>;
  };
  pm: {
    list(): Promise<ProjectManager[]>;
    save(pm: ProjectManager): Promise<ProjectManager>;
    delete(id: string): Promise<void>;
    generateInsight(pmId: string, fileId: string, fileName: string, profileId?: string): Promise<ProjectManager>;
    generateOverallInsight(pmId: string, profileId?: string): Promise<ProjectManager>;
    markAutoProcessed(pmId: string): Promise<ProjectManager>;
    run(pmId: string, profileId?: string): Promise<PmRunResult>;
  };
  persona: {
    list(): Promise<CustomPersona[]>;
    save(persona: CustomPersona): Promise<CustomPersona>;
    delete(id: string): Promise<void>;
  };
  storage: {
    getPreference(): Promise<StoragePreference>;
    setPreference(preference: StoragePreference, s3SecretKey?: string | null): Promise<void>;
    listTeams(): Promise<StorageTeam[]>;
    createTeam(name: string): Promise<StorageTeam>;
    deleteTeam(teamId: string): Promise<void>;
    listFiles(teamId: string): Promise<StorageFile[]>;
    uploadFile(uploadId: string, teamId: string, filePath: string, displayName?: string): Promise<StorageFile>;
    onUploadProgress(callback: (progress: { uploadId: string; percent: number }) => void): () => void;
    downloadToLibrary(fileId: string): Promise<Video>;
    deleteFile(fileId: string): Promise<void>;
    getShareableLink(fileId: string): Promise<ShareLink>;
    getCachedShareLink(fileId: string): Promise<ShareLink | null>;
  };
}
