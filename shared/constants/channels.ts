/** IPC channel names. Single source of truth — used by both ipcMain.handle registrations
 *  (electron/main/ipc/*.ts) and the preload contextBridge (electron/preload/index.ts). */
export const Channels = {
  capture: {
    listTargets: "capture:listTargets",
  },
  cursor: {
    /** Swaps the real OS mouse cursor for the recording's duration (see
     *  electron/main/native/systemCursor.ts) — a no-op off Windows or for style "none". */
    apply: "cursor:apply",
    /** Restores whatever the cursor looked like before `apply` — safe to call even if
     *  no override is active. */
    restore: "cursor:restore",
  },
  annotation: {
    open: "annotation:open",
    close: "annotation:close",
    /** Whether the overlay is currently open — lets the Record page's toggle button
     *  reflect reality on mount even if the overlay was opened/left open in a previous
     *  visit to the page (it deliberately doesn't close when you navigate away). */
    isOpen: "annotation:isOpen",
    setTool: "annotation:setTool",
    setColor: "annotation:setColor",
    undo: "annotation:undo",
    redo: "annotation:redo",
    clear: "annotation:clear",
    /** Draw-window renderer -> main, so main can relay button-enabled state to the
     *  Record page's embedded toolbar (which doesn't track strokes itself). */
    reportHistoryState: "annotation:reportHistoryState",
    /** Main -> every window: current tool/color, whenever either changes. */
    stateChanged: "annotation:stateChanged",
    /** Main -> draw window only: an undo/redo/clear button was pressed on the toolbar. */
    command: "annotation:command",
    /** Main -> every other window: relayed from reportHistoryState, for the embedded
     *  toolbar's undo/redo buttons. */
    historyStateChanged: "annotation:historyStateChanged",
    /** Main -> every other window: pushed whenever the overlay opens or closes, so the
     *  Record page's toggle button stays in sync even when closed some other way (e.g.
     *  app quit). */
    overlayOpenChanged: "annotation:overlayOpenChanged",
  },
  recording: {
    /** Resolves fast (once the raw webm is written) rather than waiting for the MP4
     *  transcode — see recording.ts's finishRecordingSave for why. The real Video row
     *  shows up later via saveCompleted/saveFailed. */
    save: "recording:save",
    /** Meeting tab's audio-only capture — saved as-is (no ffmpeg remux needed, Chromium
     *  plays webm audio natively) rather than going through the video remux pipeline. */
    saveAudio: "recording:saveAudio",
    /** Main -> renderer push: the background MP4 transcode + library insert kicked off
     *  by `save` finished — carries the real Video row. */
    saveCompleted: "recording:saveCompleted",
    /** Main -> renderer push: the background transcode failed. */
    saveFailed: "recording:saveFailed",
  },
  library: {
    list: "library:list",
    get: "library:get",
    delete: "library:delete",
    trim: "library:trim",
    search: "library:search",
    rename: "library:rename",
    setTranscript: "library:setTranscript",
  },
  settings: {
    getSaveDir: "settings:getSaveDir",
    setSaveDir: "settings:setSaveDir",
    pickSaveDir: "settings:pickSaveDir",
    /** Reveals a specific recording's file in the OS file explorer, selected — used by
     *  the Library page's per-recording folder icon. */
    showItemInFolder: "settings:showItemInFolder",
    listLlmProfiles: "settings:listLlmProfiles",
    getActiveLlmProfileId: "settings:getActiveLlmProfileId",
    saveLlmProfile: "settings:saveLlmProfile",
    deleteLlmProfile: "settings:deleteLlmProfile",
    setActiveLlmProfile: "settings:setActiveLlmProfile",
    /** Prefilled kind/baseUrl/model/needsKey + a fresh id, for the "add model" form. */
    defaultProfileTemplate: "settings:defaultProfileTemplate",
    getRecordSettings: "settings:getRecordSettings",
    setRecordSettings: "settings:setRecordSettings",
    getMeetingSettings: "settings:getMeetingSettings",
    setMeetingSettings: "settings:setMeetingSettings",
    /** Which local Whisper model size (tiny/base/small) to transcribe with — see
     *  shared/constants/whisperModels.ts. */
    getWhisperModel: "settings:getWhisperModel",
    setWhisperModel: "settings:setWhisperModel",
    getWhisperModelStatuses: "settings:getWhisperModelStatuses",
    downloadWhisperModel: "settings:downloadWhisperModel",
    deleteWhisperModel: "settings:deleteWhisperModel",
    getWhisperModelsDir: "settings:getWhisperModelsDir",
    openWhisperModelsDir: "settings:openWhisperModelsDir",
  },
  ai: {
    summarize: "ai:summarize",
    chat: "ai:chat",
    testConnection: "ai:testConnection",
  },
  transcription: {
    transcribe: "transcription:transcribe",
    /** Transcribes one already-decoded 16kHz mono PCM chunk (a Meeting tab live-recording
     *  segment) rather than a file already on disk. */
    transcribePcm: "transcription:transcribePcm",
    /** Stops whatever transcription is currently running (see whisperWorkerClient.ts's
     *  terminateTranscriptionWorker) — there's no per-chunk abort signal into ONNX Runtime
     *  inference itself, so this works by killing the UtilityProcess outright; the next
     *  transcribe call transparently re-forks a fresh one. */
    cancel: "transcription:cancel",
  },
  window: {
    minimize: "window:minimize",
    close: "window:close",
  },
  auth: {
    getSession: "auth:getSession",
    login: "auth:login",
    submitManualCode: "auth:submitManualCode",
    cancelLogin: "auth:cancelLogin",
    logout: "auth:logout",
    /** Main -> renderer push (session or in-flight login status changed); not an
     *  ipcMain.handle channel, subscribed to via ipcRenderer.on in the preload. */
    sessionChanged: "auth:sessionChanged",
  },
} as const;
