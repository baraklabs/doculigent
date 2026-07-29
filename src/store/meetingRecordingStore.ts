import { create } from "zustand";

interface MeetingRecordingState {
  recording: boolean;
  setRecording: (recording: boolean) => void;
}

/** Whether the Meeting tab currently has an audio recording in progress — lifted out of
 *  MeetingPage's own component state so Layout.tsx can lock tab navigation while it's true
 *  (same pattern as recordingStore.ts's useSavingRecording for the Record tab).
 *
 *  This matters because Meeting's audio capture runs entirely in the renderer via
 *  audioRecordingService (a singleton independent of any React component) rather than the
 *  main process the way RecordPage's screen capture does — so unlike Record, nothing here
 *  keeps the capture in sync with navigation on its own. Navigating away unmounts
 *  MeetingPage (losing its local `recording`/transcript state), but audioRecordingService's
 *  MediaRecorders keep running orphaned in the background; remounting the page afterward
 *  starts fresh with no way to know that session exists, and clicking "Tap to start" again
 *  calls audioRecordingService.start() a second time without ever stopping the first —
 *  which never gets its stop()/saveAudio call, so it's silently lost, and the fresh
 *  MediaRecorder's own ondataavailable handler ends up racing/corrupting the new session's
 *  chunk buffer. Locking navigation while recording (instead of trying to make the capture
 *  itself survive backgrounding, a much larger change) avoids that data loss outright. */
export const useMeetingRecordingStore = create<MeetingRecordingState>((set) => ({
  recording: false,
  setRecording: (recording) => set({ recording }),
}));
