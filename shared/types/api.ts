import type {
  AppIntegration,
  AppIntegrationKind,
  AreaRect,
  AreaSelectResult,
  AutoTranscribeSettings,
  CameraBubbleBounds,
  CameraBubbleConfig,
  CaptureMode,
  CaptureTarget,
  BackgroundEditSettings,
  CameraEditSettings,
  ChatMessage,
  CursorEditSettings,
  EditProject,
  EditProjectMedia,
  EditProjectSource,
  LayoutEditSettings,
  SoundEditSettings,
  LlmModelProfile,
  LlmProviderKind,
  MicConfig,
  OverlayConfig,
  RecordingDockAction,
  RecordingDockBounds,
  RecordingDockConfig,
  RecordingDockOrientation,
  RecordingDockTimerSync,
  RecordingSaveResult,
  SaveAudioInput,
  SaveRecordingInput,
  SystemAudioConfig,
  Summary,
  TimelineEditSettings,
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
    getPermissionStatus(): Promise<{
      screen: "not-determined" | "granted" | "denied" | "restricted" | "unknown";
      microphone: "not-determined" | "granted" | "denied" | "restricted" | "unknown";
    }>;
    openScreenRecordingSettings(): Promise<void>;
    /** Opens System Settings' Input Monitoring pane (macOS only, no-op elsewhere) — needed
     *  for click polling (Timeline's "auto zoom on clicks"). No matching
     *  getPermissionStatus-style check exists for this one; Electron doesn't expose it. */
    openInputMonitoringSettings(): Promise<void>;
    /** Registers which capture target the next getDisplayMedia() call (the non-native
     *  screen-recording fallback) should resolve to — see main/displayMedia.ts. */
    setDisplayMediaTarget(targetId: string | null): Promise<void>;
  };
  cursor: {
    startCapture(targetId: string, area?: AreaRect | null): Promise<void>;
    stopCapture(): Promise<void>;
  };
  screenCapture: {
    start(
      targetId: string,
      hideCursor: boolean,
      area?: AreaRect,
      mode?: "quick" | "advanced"
    ): Promise<{ available: boolean; contentProtected: boolean }>;
    stop(): Promise<{ available: boolean; filePath?: string }>;
    pause(): Promise<boolean>;
    resume(): Promise<boolean>;
    discard(): Promise<void>;
  };
  cameraBubble: {
    open(config: Pick<CameraBubbleConfig, "mirror" | "cameraDeviceId" | "blur">): Promise<void>;
    close(): Promise<void>;
    updateConfig(config: Pick<CameraBubbleConfig, "mirror" | "cameraDeviceId" | "blur">): Promise<void>;
    setShape(shape: Pick<CameraBubbleConfig, "shape" | "roundedCorners" | "freeformResize">): Promise<void>;
    setShapeRegion(rects: CameraBubbleBounds[]): Promise<void>;
    isOpen(): Promise<boolean>;
    getConfig(): Promise<CameraBubbleConfig>;
    getBounds(): Promise<CameraBubbleBounds | null>;
    setBounds(bounds: CameraBubbleBounds): Promise<void>;
    startTrack(): Promise<void>;
    stopTrack(): Promise<void>;
    /** `contentProtected` says whether the active screen-capture backend can be trusted to
     *  exclude this window on its own (Windows' gdigrab native path, macOS's
     *  ScreenCaptureKit path) — when it can't (any getDisplayMedia fallback, macOS's
     *  avfoundation fallback), the bubble window is hidden outright while recording
     *  instead. `keepVisible` (Quick Recording) skips that hide logic entirely — the
     *  window is deliberately left visible/unprotected (see setContentProtected below) so
     *  the native capture burns it in directly. See
     *  cameraBubbleWindow.ts's setCameraBubbleRecordingActive. */
    setRecordingActive(active: boolean, contentProtected?: boolean, keepVisible?: boolean): Promise<void>;
    /** Quick Recording calls this with `false` before starting native capture so the bubble
     *  is already visible to it from the first frame — always restored to `true` the moment
     *  a recording ends (see setRecordingActive's `active === false` branch). */
    setContentProtected(protect: boolean): Promise<void>;
    onConfigChanged(callback: (config: CameraBubbleConfig) => void): () => void;
    onClosedByUser(callback: () => void): () => void;
    onHoverChanged(callback: (hovering: boolean) => void): () => void;
    onRecordingActiveChanged(callback: (active: boolean, contentProtected: boolean) => void): () => void;
  };
  recordingDock: {
    open(): Promise<void>;
    close(): Promise<void>;
    setOrientation(orientation: RecordingDockOrientation): Promise<void>;
    getConfig(): Promise<RecordingDockConfig>;
    getBounds(): Promise<RecordingDockBounds | null>;
    setBounds(bounds: RecordingDockBounds): Promise<void>;
    /** The dock window permanently reserves room for its popovers/tooltips (it never
     *  resizes — see sizeFor), so most of it is empty transparent space. This toggles
     *  click-through for that space: the renderer reports whether the pointer is actually
     *  over the bar (or an open popover), and everywhere else clicks pass to whatever is
     *  behind the dock instead of being swallowed by the window. */
    setInteractive(interactive: boolean): Promise<void>;
    sendAction(action: RecordingDockAction): Promise<void>;
    syncTimer(sync: RecordingDockTimerSync): Promise<void>;
    /** Pulls whatever the last pushed syncTimer value was — for the dock's own mount,
     *  rather than only ever relying on that push, which is dropped with no queueing if
     *  it lands before the dock's onTimerSync listener is registered. */
    getTimerSync(): Promise<RecordingDockTimerSync | null>;
    showMainWindow(): Promise<void>;
    hideMainWindow(): Promise<void>;
    isMainWindowVisible(): Promise<boolean>;
    onConfigChanged(callback: (config: RecordingDockConfig) => void): () => void;
    onAction(callback: (action: RecordingDockAction) => void): () => void;
    onTimerSync(callback: (sync: RecordingDockTimerSync) => void): () => void;
    onMainWindowVisibilityChanged(callback: (visible: boolean) => void): () => void;
  };
  countdown: {
    open(secondsRemaining: number): Promise<void>;
    close(): Promise<void>;
    cancel(): Promise<void>;
    onTick(callback: (secondsRemaining: number) => void): () => void;
    onCancelled(callback: () => void): () => void;
  };
  areaSelect: {
    open(): Promise<void>;
    activate(): Promise<void>;
    complete(targetId: string, rect: AreaRect): Promise<void>;
    cancel(): Promise<void>;
    onCompleted(callback: (result: AreaSelectResult) => void): () => void;
    onCancelled(callback: () => void): () => void;
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
    save(input: SaveRecordingInput): Promise<{ id: string }>;
    saveAudio(input: SaveAudioInput): Promise<Video>;
    onSaveProgress(callback: (progress: { id: string; percent: number }) => void): () => void;
    cancelSave(id: string): Promise<boolean>;
    onSaveCompleted(callback: (result: RecordingSaveResult) => void): () => void;
    onSaveFailed(callback: (failure: { id: string; message: string }) => void): () => void;
  };
  editProjects: {
    list(): Promise<EditProject[]>;
    get(id: string): Promise<EditProject | null>;
    create(title: string, source?: EditProjectSource): Promise<EditProject>;
    rename(id: string, title: string): Promise<EditProject>;
    updateCamera(id: string, camera: CameraEditSettings): Promise<EditProject>;
    updateCursor(id: string, cursor: CursorEditSettings): Promise<EditProject>;
    updateBackground(id: string, background: BackgroundEditSettings): Promise<EditProject>;
    updateSound(id: string, sound: SoundEditSettings): Promise<EditProject>;
    updateLayout(id: string, layout: LayoutEditSettings): Promise<EditProject>;
    updateTimeline(id: string, timeline: TimelineEditSettings): Promise<EditProject>;
    pickBackgroundImage(): Promise<string | null>;
    getMedia(id: string): Promise<EditProjectMedia>;
    delete(id: string, deleteSourceFiles?: boolean): Promise<void>;
    deleteMany(ids: string[], deleteSourceFiles?: boolean): Promise<void>;
    // Broadcast right before a delete touches these projects' files, so an Edit page that
    // still has one of them open (its own video elements actively holding the file, even
    // if the tab isn't the active route yet) can drop it immediately instead of leaving
    // the delete to fail with EBUSY on Windows.
    onReleaseMedia(callback: (ids: string[]) => void): () => void;
    export(
      exportId: string,
      input: {
        webmBytes: ArrayBuffer;
        title: string;
        durationSecs: number;
        width: number;
        height: number;
        fps: number;
      }
    ): Promise<{ canceled: boolean; filePath?: string }>;
    exportCancel(exportId: string): Promise<boolean>;
    onExportProgress(callback: (progress: { exportId: string; percent: number }) => void): () => void;
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
    getRecordingsDir(): Promise<string>;
    setRecordingsDir(dir: string): Promise<void>;
    pickRecordingsDir(): Promise<string | null>;
    getMeetingsDir(): Promise<string>;
    setMeetingsDir(dir: string): Promise<void>;
    pickMeetingsDir(): Promise<string | null>;
    getProjectsDir(): Promise<string>;
    setProjectsDir(dir: string): Promise<void>;
    pickProjectsDir(): Promise<string | null>;
    getTeamsDir(): Promise<string>;
    setTeamsDir(dir: string): Promise<void>;
    pickTeamsDir(): Promise<string | null>;
    showItemInFolder(filePath: string): Promise<void>;
    listLlmProfiles(): Promise<LlmModelProfile[]>;
    saveLlmProfile(profile: LlmModelProfile, apiKey?: string | null): Promise<void>;
    deleteLlmProfile(id: string): Promise<void>;
    defaultProfileTemplate(kind: LlmProviderKind): Promise<LlmModelProfile>;
    getRecordSettings(): Promise<{
      overlay: OverlayConfig | null;
      targetId: string | null;
      mic: MicConfig | null;
      systemAudio: SystemAudioConfig | null;
      captureMode: CaptureMode | null;
      areaRect: AreaRect | null;
      countdownSecs: number | null;
      recordingMode: "quick" | "advanced" | null;
    }>;
    setRecordSettings(
      overlay: OverlayConfig,
      targetId: string | null,
      mic: MicConfig | null,
      systemAudio: SystemAudioConfig | null,
      captureMode: CaptureMode | null,
      areaRect: AreaRect | null,
      countdownSecs: number | null,
      recordingMode: "quick" | "advanced" | null
    ): Promise<void>;
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
