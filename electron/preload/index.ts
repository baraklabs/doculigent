import { contextBridge, ipcRenderer, webUtils } from "electron";
import { Channels } from "@shared/constants/channels";
import type { DoculigentApi } from "@shared/types/api";
import type { AuthSession, LoginStatus } from "@shared/types/auth";
import type { AnnotationCommand, AnnotationState } from "@shared/types/annotation";
import type { Video } from "@shared/types/models";

const api: DoculigentApi = {
  system: {
    platform: process.platform,
    arch: process.arch,
    getPathForFile: (file) => webUtils.getPathForFile(file),
  },
  capture: {
    listTargets: () => ipcRenderer.invoke(Channels.capture.listTargets),
  },
  cursor: {
    apply: (style) => ipcRenderer.invoke(Channels.cursor.apply, style),
    restore: () => ipcRenderer.invoke(Channels.cursor.restore),
    startCapture: (targetId, style) => ipcRenderer.invoke(Channels.cursor.startCapture, targetId, style),
    stopCapture: () => ipcRenderer.invoke(Channels.cursor.stopCapture),
  },
  screenCapture: {
    start: (targetId, hideCursor) => ipcRenderer.invoke(Channels.screenCapture.start, targetId, hideCursor),
    stop: () => ipcRenderer.invoke(Channels.screenCapture.stop),
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
  library: {
    list: () => ipcRenderer.invoke(Channels.library.list),
    get: (id) => ipcRenderer.invoke(Channels.library.get, id),
    delete: (id, keepFile) => ipcRenderer.invoke(Channels.library.delete, id, keepFile),
    deleteMany: (ids, keepFile) => ipcRenderer.invoke(Channels.library.deleteMany, ids, keepFile),
    search: (query) => ipcRenderer.invoke(Channels.library.search, query),
    rename: (id, title) => ipcRenderer.invoke(Channels.library.rename, id, title),
    setTranscript: (id, transcript) => ipcRenderer.invoke(Channels.library.setTranscript, id, transcript),
  },
  editProjects: {
    list: () => ipcRenderer.invoke(Channels.editProjects.list),
    get: (id) => ipcRenderer.invoke(Channels.editProjects.get, id),
    create: (input) => ipcRenderer.invoke(Channels.editProjects.create, input),
    update: (id, patch) => ipcRenderer.invoke(Channels.editProjects.update, id, patch),
    delete: (id) => ipcRenderer.invoke(Channels.editProjects.delete, id),
    pickImportFile: () => ipcRenderer.invoke(Channels.editProjects.pickImportFile),
    fileExists: (filePath) => ipcRenderer.invoke(Channels.editProjects.fileExists, filePath),
    export: (id, keepRanges) => ipcRenderer.invoke(Channels.editProjects.export, id, keepRanges),
  },
  settings: {
    getSaveDir: () => ipcRenderer.invoke(Channels.settings.getSaveDir),
    setSaveDir: (dir) => ipcRenderer.invoke(Channels.settings.setSaveDir, dir),
    pickSaveDir: () => ipcRenderer.invoke(Channels.settings.pickSaveDir),
    showItemInFolder: (filePath) => ipcRenderer.invoke(Channels.settings.showItemInFolder, filePath),
    listLlmProfiles: () => ipcRenderer.invoke(Channels.settings.listLlmProfiles),
    getActiveLlmProfileId: () => ipcRenderer.invoke(Channels.settings.getActiveLlmProfileId),
    saveLlmProfile: (profile, apiKey) => ipcRenderer.invoke(Channels.settings.saveLlmProfile, profile, apiKey),
    deleteLlmProfile: (id) => ipcRenderer.invoke(Channels.settings.deleteLlmProfile, id),
    setActiveLlmProfile: (id) => ipcRenderer.invoke(Channels.settings.setActiveLlmProfile, id),
    defaultProfileTemplate: (kind) => ipcRenderer.invoke(Channels.settings.defaultProfileTemplate, kind),
    getRecordSettings: () => ipcRenderer.invoke(Channels.settings.getRecordSettings),
    setRecordSettings: (overlay, targetId, mic) =>
      ipcRenderer.invoke(Channels.settings.setRecordSettings, overlay, targetId, mic),
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
  },
  ai: {
    summarize: (transcript, profileId) => ipcRenderer.invoke(Channels.ai.summarize, transcript, profileId),
    chat: (transcript, history, question, profileId) =>
      ipcRenderer.invoke(Channels.ai.chat, transcript, history, question, profileId),
    testConnection: (profile, apiKey) => ipcRenderer.invoke(Channels.ai.testConnection, profile, apiKey),
  },
  transcription: {
    transcribe: (filePath, language, modelSize) =>
      ipcRenderer.invoke(Channels.transcription.transcribe, filePath, language, modelSize),
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
};

contextBridge.exposeInMainWorld("api", api);
