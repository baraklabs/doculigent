import { contextBridge, ipcRenderer, webUtils } from "electron";
import { Channels } from "@shared/constants/channels";
import type { DoculigentApi } from "@shared/types/api";
import type { AuthSession, LoginStatus } from "@shared/types/auth";
import type { AnnotationCommand, AnnotationState } from "@shared/types/annotation";
import type {
  AreaSelectResult,
  CameraBubbleConfig,
  RecordingDockAction,
  RecordingDockConfig,
  RecordingDockTimerSync,
  Video,
} from "@shared/types/models";
import type { TeamFileStatus } from "@shared/types/team";
import type { StoragePreference } from "@shared/types/storage";

const api: DoculigentApi = {
  system: {
    platform: process.platform,
    arch: process.arch,
    getPathForFile: (file) => webUtils.getPathForFile(file),
  },
  capture: {
    listTargets: () => ipcRenderer.invoke(Channels.capture.listTargets),
    getPermissionStatus: () => ipcRenderer.invoke(Channels.capture.getPermissionStatus),
    openScreenRecordingSettings: () => ipcRenderer.invoke(Channels.capture.openScreenRecordingSettings),
  },
  cursor: {
    startCapture: (targetId, area) => ipcRenderer.invoke(Channels.cursor.startCapture, targetId, area),
    stopCapture: () => ipcRenderer.invoke(Channels.cursor.stopCapture),
  },
  screenCapture: {
    start: (targetId, hideCursor, area) => ipcRenderer.invoke(Channels.screenCapture.start, targetId, hideCursor, area),
    stop: () => ipcRenderer.invoke(Channels.screenCapture.stop),
    pause: () => ipcRenderer.invoke(Channels.screenCapture.pause),
    resume: () => ipcRenderer.invoke(Channels.screenCapture.resume),
    discard: () => ipcRenderer.invoke(Channels.screenCapture.discard),
  },
  cameraBubble: {
    open: (config) => ipcRenderer.invoke(Channels.cameraBubble.open, config),
    close: () => ipcRenderer.invoke(Channels.cameraBubble.close),
    updateConfig: (config) => ipcRenderer.invoke(Channels.cameraBubble.updateConfig, config),
    setShape: (shape) => ipcRenderer.invoke(Channels.cameraBubble.setShape, shape),
    setShapeRegion: (rects) => ipcRenderer.invoke(Channels.cameraBubble.setShapeRegion, rects),
    isOpen: () => ipcRenderer.invoke(Channels.cameraBubble.isOpen),
    getConfig: () => ipcRenderer.invoke(Channels.cameraBubble.getConfig),
    getBounds: () => ipcRenderer.invoke(Channels.cameraBubble.getBounds),
    setBounds: (bounds) => ipcRenderer.invoke(Channels.cameraBubble.setBounds, bounds),
    startTrack: () => ipcRenderer.invoke(Channels.cameraBubble.startTrack),
    stopTrack: () => ipcRenderer.invoke(Channels.cameraBubble.stopTrack),
    setRecordingActive: (active, native) => ipcRenderer.invoke(Channels.cameraBubble.setRecordingActive, active, native ?? false),
    onConfigChanged: (callback) => {
      const listener = (_event: unknown, config: CameraBubbleConfig) => callback(config);
      ipcRenderer.on(Channels.cameraBubble.configChanged, listener);
      return () => ipcRenderer.removeListener(Channels.cameraBubble.configChanged, listener);
    },
    onClosedByUser: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(Channels.cameraBubble.closedByUser, listener);
      return () => ipcRenderer.removeListener(Channels.cameraBubble.closedByUser, listener);
    },
    onHoverChanged: (callback) => {
      const listener = (_event: unknown, hovering: boolean) => callback(hovering);
      ipcRenderer.on(Channels.cameraBubble.hoverChanged, listener);
      return () => ipcRenderer.removeListener(Channels.cameraBubble.hoverChanged, listener);
    },
    onRecordingActiveChanged: (callback) => {
      const listener = (_event: unknown, active: boolean, native: boolean) => callback(active, native);
      ipcRenderer.on(Channels.cameraBubble.recordingActiveChanged, listener);
      return () => ipcRenderer.removeListener(Channels.cameraBubble.recordingActiveChanged, listener);
    },
  },
  recordingDock: {
    open: () => ipcRenderer.invoke(Channels.recordingDock.open),
    close: () => ipcRenderer.invoke(Channels.recordingDock.close),
    setOrientation: (orientation) => ipcRenderer.invoke(Channels.recordingDock.setOrientation, orientation),
    getConfig: () => ipcRenderer.invoke(Channels.recordingDock.getConfig),
    getBounds: () => ipcRenderer.invoke(Channels.recordingDock.getBounds),
    setBounds: (bounds) => ipcRenderer.invoke(Channels.recordingDock.setBounds, bounds),
    sendAction: (action) => ipcRenderer.invoke(Channels.recordingDock.sendAction, action),
    syncTimer: (sync) => ipcRenderer.invoke(Channels.recordingDock.syncTimer, sync),
    showMainWindow: () => ipcRenderer.invoke(Channels.recordingDock.showMainWindow),
    hideMainWindow: () => ipcRenderer.invoke(Channels.recordingDock.hideMainWindow),
    isMainWindowVisible: () => ipcRenderer.invoke(Channels.recordingDock.isMainWindowVisible),
    onConfigChanged: (callback) => {
      const listener = (_event: unknown, config: RecordingDockConfig) => callback(config);
      ipcRenderer.on(Channels.recordingDock.configChanged, listener);
      return () => ipcRenderer.removeListener(Channels.recordingDock.configChanged, listener);
    },
    onAction: (callback) => {
      const listener = (_event: unknown, action: RecordingDockAction) => callback(action);
      ipcRenderer.on(Channels.recordingDock.action, listener);
      return () => ipcRenderer.removeListener(Channels.recordingDock.action, listener);
    },
    onTimerSync: (callback) => {
      const listener = (_event: unknown, sync: RecordingDockTimerSync) => callback(sync);
      ipcRenderer.on(Channels.recordingDock.timerSync, listener);
      return () => ipcRenderer.removeListener(Channels.recordingDock.timerSync, listener);
    },
    onMainWindowVisibilityChanged: (callback) => {
      const listener = (_event: unknown, visible: boolean) => callback(visible);
      ipcRenderer.on(Channels.recordingDock.mainWindowVisibilityChanged, listener);
      return () => ipcRenderer.removeListener(Channels.recordingDock.mainWindowVisibilityChanged, listener);
    },
  },
  countdown: {
    open: (secondsRemaining) => ipcRenderer.invoke(Channels.countdown.open, secondsRemaining),
    close: () => ipcRenderer.invoke(Channels.countdown.close),
    cancel: () => ipcRenderer.invoke(Channels.countdown.cancel),
    onTick: (callback) => {
      const listener = (_event: unknown, secondsRemaining: number) => callback(secondsRemaining);
      ipcRenderer.on(Channels.countdown.tick, listener);
      return () => ipcRenderer.removeListener(Channels.countdown.tick, listener);
    },
    onCancelled: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(Channels.countdown.cancelled, listener);
      return () => ipcRenderer.removeListener(Channels.countdown.cancelled, listener);
    },
  },
  areaSelect: {
    open: () => ipcRenderer.invoke(Channels.areaSelect.open),
    activate: () => ipcRenderer.invoke(Channels.areaSelect.activate),
    complete: (targetId, rect) => ipcRenderer.invoke(Channels.areaSelect.complete, targetId, rect),
    cancel: () => ipcRenderer.invoke(Channels.areaSelect.cancel),
    onCompleted: (callback) => {
      const listener = (_event: unknown, result: AreaSelectResult) => callback(result);
      ipcRenderer.on(Channels.areaSelect.completed, listener);
      return () => ipcRenderer.removeListener(Channels.areaSelect.completed, listener);
    },
    onCancelled: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(Channels.areaSelect.cancelled, listener);
      return () => ipcRenderer.removeListener(Channels.areaSelect.cancelled, listener);
    },
  },
  annotation: {
    open: () => ipcRenderer.invoke(Channels.annotation.open),
    isOpen: () => ipcRenderer.invoke(Channels.annotation.isOpen),
    getState: () => ipcRenderer.invoke(Channels.annotation.getState),
    setTool: (tool) => ipcRenderer.invoke(Channels.annotation.setTool, tool),
    setColor: (color) => ipcRenderer.invoke(Channels.annotation.setColor, color),
    setWidth: (width) => ipcRenderer.invoke(Channels.annotation.setWidth, width),
    setOpacity: (opacity) => ipcRenderer.invoke(Channels.annotation.setOpacity, opacity),
    setFadeMs: (fadeMs) => ipcRenderer.invoke(Channels.annotation.setFadeMs, fadeMs),
    undo: () => ipcRenderer.invoke(Channels.annotation.undo),
    redo: () => ipcRenderer.invoke(Channels.annotation.redo),
    clear: () => ipcRenderer.invoke(Channels.annotation.clear),
    reportHistoryState: (canUndo, canRedo) =>
      ipcRenderer.invoke(Channels.annotation.reportHistoryState, canUndo, canRedo),
    setStrokeActive: (active) => ipcRenderer.invoke(Channels.annotation.setStrokeActive, active),
    onStateChanged: (callback) => {
      const listener = (_event: unknown, state: AnnotationState) => callback(state);
      ipcRenderer.on(Channels.annotation.stateChanged, listener);
      return () => ipcRenderer.removeListener(Channels.annotation.stateChanged, listener);
    },
    onCommand: (callback) => {
      const listener = (_event: unknown, command: AnnotationCommand) => callback(command);
      ipcRenderer.on(Channels.annotation.command, listener);
      return () => ipcRenderer.removeListener(Channels.annotation.command, listener);
    },
    onHistoryStateChanged: (callback) => {
      const listener = (_event: unknown, state: { canUndo: boolean; canRedo: boolean }) => callback(state);
      ipcRenderer.on(Channels.annotation.historyStateChanged, listener);
      return () => ipcRenderer.removeListener(Channels.annotation.historyStateChanged, listener);
    },
    onOverlayOpenChanged: (callback) => {
      const listener = (_event: unknown, open: boolean) => callback(open);
      ipcRenderer.on(Channels.annotation.overlayOpenChanged, listener);
      return () => ipcRenderer.removeListener(Channels.annotation.overlayOpenChanged, listener);
    },
  },
  recording: {
    save: (input) => ipcRenderer.invoke(Channels.recording.save, input),
    saveAudio: (input) => ipcRenderer.invoke(Channels.recording.saveAudio, input),
    cancelSave: (id) => ipcRenderer.invoke(Channels.recording.cancelSave, id),
    onSaveProgress: (callback) => {
      const listener = (_event: unknown, progress: { id: string; percent: number }) => callback(progress);
      ipcRenderer.on(Channels.recording.saveProgress, listener);
      return () => ipcRenderer.removeListener(Channels.recording.saveProgress, listener);
    },
    onSaveCompleted: (callback) => {
      const listener = (_event: unknown, video: Video) => callback(video);
      ipcRenderer.on(Channels.recording.saveCompleted, listener);
      return () => ipcRenderer.removeListener(Channels.recording.saveCompleted, listener);
    },
    onSaveFailed: (callback) => {
      const listener = (_event: unknown, failure: { id: string; message: string }) => callback(failure);
      ipcRenderer.on(Channels.recording.saveFailed, listener);
      return () => ipcRenderer.removeListener(Channels.recording.saveFailed, listener);
    },
  },
  editProjects: {
    list: () => ipcRenderer.invoke(Channels.editProjects.list),
    get: (id) => ipcRenderer.invoke(Channels.editProjects.get, id),
    create: (title, source) => ipcRenderer.invoke(Channels.editProjects.create, title, source),
    rename: (id, title) => ipcRenderer.invoke(Channels.editProjects.rename, id, title),
    updateCamera: (id, camera) => ipcRenderer.invoke(Channels.editProjects.updateCamera, id, camera),
    updateCursor: (id, cursor) => ipcRenderer.invoke(Channels.editProjects.updateCursor, id, cursor),
    updateBackground: (id, background) => ipcRenderer.invoke(Channels.editProjects.updateBackground, id, background),
    updateSound: (id, sound) => ipcRenderer.invoke(Channels.editProjects.updateSound, id, sound),
    updateLayout: (id, layout) => ipcRenderer.invoke(Channels.editProjects.updateLayout, id, layout),
    updateTimeline: (id, timeline) => ipcRenderer.invoke(Channels.editProjects.updateTimeline, id, timeline),
    pickBackgroundImage: () => ipcRenderer.invoke(Channels.editProjects.pickBackgroundImage),
    getMedia: (id) => ipcRenderer.invoke(Channels.editProjects.getMedia, id),
    delete: (id) => ipcRenderer.invoke(Channels.editProjects.delete, id),
    deleteMany: (ids) => ipcRenderer.invoke(Channels.editProjects.deleteMany, ids),
    export: (exportId, input) => ipcRenderer.invoke(Channels.editProjects.export, exportId, input),
    exportCancel: (exportId) => ipcRenderer.invoke(Channels.editProjects.exportCancel, exportId),
    onExportProgress: (callback) => {
      const listener = (_event: unknown, progress: { exportId: string; percent: number }) => callback(progress);
      ipcRenderer.on(Channels.editProjects.exportProgress, listener);
      return () => ipcRenderer.removeListener(Channels.editProjects.exportProgress, listener);
    },
  },
  library: {
    list: () => ipcRenderer.invoke(Channels.library.list),
    get: (id) => ipcRenderer.invoke(Channels.library.get, id),
    delete: (id, keepFile) => ipcRenderer.invoke(Channels.library.delete, id, keepFile),
    deleteMany: (ids, keepFile) => ipcRenderer.invoke(Channels.library.deleteMany, ids, keepFile),
    search: (query) => ipcRenderer.invoke(Channels.library.search, query),
    rename: (id, title) => ipcRenderer.invoke(Channels.library.rename, id, title),
    setTranscript: (id, transcript) => ipcRenderer.invoke(Channels.library.setTranscript, id, transcript),
    pickFiles: (kind, multi) => ipcRenderer.invoke(Channels.library.pickFiles, kind, multi),
    importFiles: (filePaths, kind) => ipcRenderer.invoke(Channels.library.importFiles, filePaths, kind),
    onImportProgress: (callback) => {
      const listener = (_event: unknown, progress: { percent: number; fileIndex: number; totalFiles: number }) =>
        callback(progress);
      ipcRenderer.on(Channels.library.importProgress, listener);
      return () => ipcRenderer.removeListener(Channels.library.importProgress, listener);
    },
  },
  settings: {
    getRecordingsDir: () => ipcRenderer.invoke(Channels.settings.getRecordingsDir),
    setRecordingsDir: (dir) => ipcRenderer.invoke(Channels.settings.setRecordingsDir, dir),
    pickRecordingsDir: () => ipcRenderer.invoke(Channels.settings.pickRecordingsDir),
    getMeetingsDir: () => ipcRenderer.invoke(Channels.settings.getMeetingsDir),
    setMeetingsDir: (dir) => ipcRenderer.invoke(Channels.settings.setMeetingsDir, dir),
    pickMeetingsDir: () => ipcRenderer.invoke(Channels.settings.pickMeetingsDir),
    getProjectsDir: () => ipcRenderer.invoke(Channels.settings.getProjectsDir),
    setProjectsDir: (dir) => ipcRenderer.invoke(Channels.settings.setProjectsDir, dir),
    pickProjectsDir: () => ipcRenderer.invoke(Channels.settings.pickProjectsDir),
    getTeamsDir: () => ipcRenderer.invoke(Channels.settings.getTeamsDir),
    setTeamsDir: (dir) => ipcRenderer.invoke(Channels.settings.setTeamsDir, dir),
    pickTeamsDir: () => ipcRenderer.invoke(Channels.settings.pickTeamsDir),
    showItemInFolder: (filePath) => ipcRenderer.invoke(Channels.settings.showItemInFolder, filePath),
    listLlmProfiles: () => ipcRenderer.invoke(Channels.settings.listLlmProfiles),
    saveLlmProfile: (profile, apiKey) => ipcRenderer.invoke(Channels.settings.saveLlmProfile, profile, apiKey),
    deleteLlmProfile: (id) => ipcRenderer.invoke(Channels.settings.deleteLlmProfile, id),
    defaultProfileTemplate: (kind) => ipcRenderer.invoke(Channels.settings.defaultProfileTemplate, kind),
    getRecordSettings: () => ipcRenderer.invoke(Channels.settings.getRecordSettings),
    setRecordSettings: (overlay, targetId, mic, systemAudio, captureMode, areaRect, countdownSecs) =>
      ipcRenderer.invoke(
        Channels.settings.setRecordSettings,
        overlay,
        targetId,
        mic,
        systemAudio,
        captureMode,
        areaRect,
        countdownSecs
      ),
    getMeetingSettings: () => ipcRenderer.invoke(Channels.settings.getMeetingSettings),
    setMeetingSettings: (language, micEnabled, micDeviceId, systemAudioEnabled, systemAudioSourceId) =>
      ipcRenderer.invoke(
        Channels.settings.setMeetingSettings,
        language,
        micEnabled,
        micDeviceId,
        systemAudioEnabled,
        systemAudioSourceId
      ),
    getWhisperModel: () => ipcRenderer.invoke(Channels.settings.getWhisperModel),
    setWhisperModel: (size) => ipcRenderer.invoke(Channels.settings.setWhisperModel, size),
    getWhisperModelStatuses: () => ipcRenderer.invoke(Channels.settings.getWhisperModelStatuses),
    downloadWhisperModel: (size) => ipcRenderer.invoke(Channels.settings.downloadWhisperModel, size),
    deleteWhisperModel: (size) => ipcRenderer.invoke(Channels.settings.deleteWhisperModel, size),
    getWhisperModelsDir: () => ipcRenderer.invoke(Channels.settings.getWhisperModelsDir),
    openWhisperModelsDir: () => ipcRenderer.invoke(Channels.settings.openWhisperModelsDir),
    getUseDoculigentModel: () => ipcRenderer.invoke(Channels.settings.getUseDoculigentModel),
    setUseDoculigentModel: (use) => ipcRenderer.invoke(Channels.settings.setUseDoculigentModel, use),
    getTranscriptionByokProfileId: () => ipcRenderer.invoke(Channels.settings.getTranscriptionByokProfileId),
    setTranscriptionByokProfileId: (id) => ipcRenderer.invoke(Channels.settings.setTranscriptionByokProfileId, id),
    getAutoTranscribeSettings: () => ipcRenderer.invoke(Channels.settings.getAutoTranscribeSettings),
    setAutoTranscribeSettings: (settings) => ipcRenderer.invoke(Channels.settings.setAutoTranscribeSettings, settings),
  },
  ai: {
    summarize: (transcript, profileId) => ipcRenderer.invoke(Channels.ai.summarize, transcript, profileId),
    chat: (transcript, history, question, profileId, systemPromptOverride) =>
      ipcRenderer.invoke(Channels.ai.chat, transcript, history, question, profileId, systemPromptOverride),
    testConnection: (profile, apiKey) => ipcRenderer.invoke(Channels.ai.testConnection, profile, apiKey),
  },
  apps: {
    list: () => ipcRenderer.invoke(Channels.apps.list),
    save: (integration, secret) => ipcRenderer.invoke(Channels.apps.save, integration, secret),
    delete: (id) => ipcRenderer.invoke(Channels.apps.delete, id),
    testConnection: (kind, integrationId, secret) =>
      ipcRenderer.invoke(Channels.apps.testConnection, kind, integrationId, secret),
    githubCreateIssue: (integrationId, repo, title, body) =>
      ipcRenderer.invoke(Channels.apps.githubCreateIssue, integrationId, repo, title, body),
    githubCommentIssue: (integrationId, repo, issueNumber, body) =>
      ipcRenderer.invoke(Channels.apps.githubCommentIssue, integrationId, repo, issueNumber, body),
    slackPostMessage: (integrationId, channel, text) =>
      ipcRenderer.invoke(Channels.apps.slackPostMessage, integrationId, channel, text),
  },
  transcription: {
    transcribe: (filePath, language, modelSize, byokProfileId) =>
      ipcRenderer.invoke(Channels.transcription.transcribe, filePath, language, modelSize, byokProfileId),
    transcribePcm: (samples, language) => ipcRenderer.invoke(Channels.transcription.transcribePcm, samples, language),
    cancel: () => ipcRenderer.invoke(Channels.transcription.cancel),
  },
  window: {
    minimize: () => ipcRenderer.invoke(Channels.window.minimize),
    close: () => ipcRenderer.invoke(Channels.window.close),
    toggleMaximize: () => ipcRenderer.invoke(Channels.window.toggleMaximize),
    isMaximized: () => ipcRenderer.invoke(Channels.window.isMaximized),
    onMaximizeChanged: (callback) => {
      const listener = (_event: unknown, maximized: boolean) => callback(maximized);
      ipcRenderer.on(Channels.window.maximizeChanged, listener);
      return () => ipcRenderer.removeListener(Channels.window.maximizeChanged, listener);
    },
  },
  auth: {
    getSession: () => ipcRenderer.invoke(Channels.auth.getSession),
    login: () => ipcRenderer.invoke(Channels.auth.login),
    submitManualCode: (code) => ipcRenderer.invoke(Channels.auth.submitManualCode, code),
    cancelLogin: () => ipcRenderer.invoke(Channels.auth.cancelLogin),
    logout: () => ipcRenderer.invoke(Channels.auth.logout),
    onSessionChanged: (callback) => {
      const listener = (_event: unknown, session: AuthSession | null, status: LoginStatus) =>
        callback(session, status);
      ipcRenderer.on(Channels.auth.sessionChanged, listener);
      return () => ipcRenderer.removeListener(Channels.auth.sessionChanged, listener);
    },
  },
  teams: {
    create: (name) => ipcRenderer.invoke(Channels.teams.create, name),
    list: () => ipcRenderer.invoke(Channels.teams.list),
    get: (teamId) => ipcRenderer.invoke(Channels.teams.get, teamId),
    inviteMember: (teamId, email) => ipcRenderer.invoke(Channels.teams.inviteMember, teamId, email),
    removeMember: (teamId, memberId) => ipcRenderer.invoke(Channels.teams.removeMember, teamId, memberId),
    delete: (teamId) => ipcRenderer.invoke(Channels.teams.delete, teamId),
    listFiles: (teamId, status) => ipcRenderer.invoke(Channels.teams.listFiles, teamId, status),
    presignDownload: (fileId) => ipcRenderer.invoke(Channels.teams.presignDownload, fileId),
    setFileStatus: (fileId, status: TeamFileStatus) => ipcRenderer.invoke(Channels.teams.setFileStatus, fileId, status),
    permanentlyDeleteFile: (fileId) => ipcRenderer.invoke(Channels.teams.permanentlyDeleteFile, fileId),
    uploadFile: (uploadId, teamId, filePath, displayName) =>
      ipcRenderer.invoke(Channels.teams.uploadFile, uploadId, teamId, filePath, displayName),
    onUploadProgress: (callback) => {
      const listener = (_event: unknown, progress: { uploadId: string; percent: number }) => callback(progress);
      ipcRenderer.on(Channels.teams.uploadProgress, listener);
      return () => ipcRenderer.removeListener(Channels.teams.uploadProgress, listener);
    },
    downloadToLibrary: (teamId, fileId) => ipcRenderer.invoke(Channels.teams.downloadToLibrary, teamId, fileId),
    listSyncedFileIds: () => ipcRenderer.invoke(Channels.teams.listSyncedFileIds),
  },
  pm: {
    list: () => ipcRenderer.invoke(Channels.pm.list),
    save: (pm) => ipcRenderer.invoke(Channels.pm.save, pm),
    delete: (id) => ipcRenderer.invoke(Channels.pm.delete, id),
    generateInsight: (pmId, fileId, fileName, profileId) =>
      ipcRenderer.invoke(Channels.pm.generateInsight, pmId, fileId, fileName, profileId),
    generateOverallInsight: (pmId, profileId) => ipcRenderer.invoke(Channels.pm.generateOverallInsight, pmId, profileId),
    markAutoProcessed: (pmId) => ipcRenderer.invoke(Channels.pm.markAutoProcessed, pmId),
    run: (pmId) => ipcRenderer.invoke(Channels.pm.run, pmId),
  },
  persona: {
    list: () => ipcRenderer.invoke(Channels.persona.list),
    save: (persona) => ipcRenderer.invoke(Channels.persona.save, persona),
    delete: (id) => ipcRenderer.invoke(Channels.persona.delete, id),
  },
  storage: {
    getPreference: () => ipcRenderer.invoke(Channels.storage.getPreference),
    setPreference: (preference: StoragePreference, s3SecretKey?: string | null) =>
      ipcRenderer.invoke(Channels.storage.setPreference, preference, s3SecretKey),
    listTeams: () => ipcRenderer.invoke(Channels.storage.listTeams),
    createTeam: (name) => ipcRenderer.invoke(Channels.storage.createTeam, name),
    deleteTeam: (teamId) => ipcRenderer.invoke(Channels.storage.deleteTeam, teamId),
    listFiles: (teamId) => ipcRenderer.invoke(Channels.storage.listFiles, teamId),
    uploadFile: (uploadId, teamId, filePath, displayName) =>
      ipcRenderer.invoke(Channels.storage.uploadFile, uploadId, teamId, filePath, displayName),
    onUploadProgress: (callback) => {
      const listener = (_event: unknown, progress: { uploadId: string; percent: number }) => callback(progress);
      ipcRenderer.on(Channels.storage.uploadProgress, listener);
      return () => ipcRenderer.removeListener(Channels.storage.uploadProgress, listener);
    },
    downloadToLibrary: (fileId) => ipcRenderer.invoke(Channels.storage.downloadToLibrary, fileId),
    deleteFile: (fileId) => ipcRenderer.invoke(Channels.storage.deleteFile, fileId),
    getShareableLink: (fileId) => ipcRenderer.invoke(Channels.storage.getShareableLink, fileId),
    getCachedShareLink: (fileId) => ipcRenderer.invoke(Channels.storage.getCachedShareLink, fileId),
  },
};

contextBridge.exposeInMainWorld("api", api);
