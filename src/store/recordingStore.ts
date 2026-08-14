import { create } from "zustand";
import type { AreaRect, CaptureMode, MicConfig, OverlayConfig, SystemAudioConfig, Video } from "@shared/types/models";
import { recordingService } from "../services/recording/RecordingService";
import { SettingsService } from "../services/settings/SettingsService";
import { TranscriptionService } from "../services/transcription/TranscriptionService";
import { LibraryService } from "../services/library/LibraryService";
import { queryClient } from "../lib/queryClient";
export interface RecordingSaveStatus {
  id: string;
  status: "processing" | "ready" | "failed" | "cancelled";
  /** MP4 transcode progress, 0-100. */
  percent: number;
  message?: string;
}

interface StartArgs {
  targetId: string;
  overlay: OverlayConfig;
  mic: MicConfig;
  systemAudio: SystemAudioConfig;
  title: string;
  source: "record" | "meeting";
  captureMode: CaptureMode;
  areaRect: AreaRect | null;
}

/** Remembered outside the store's reactive state — restart() replays these, and nothing
 *  needs to re-render when they're set. */
let lastStartArgs: StartArgs | null = null;

interface RecordingState {
  recording: boolean;
  paused: boolean;
  busy: boolean;
  stopping: boolean;
  error: string | null;
  title: string;
  source: "record" | "meeting";
  saveStatus: RecordingSaveStatus | null;
  dismissSaveStatus: () => void;
  cancelSave: () => Promise<void>;
  start: (
    targetId: string,
    overlay: OverlayConfig,
    mic: MicConfig,
    systemAudio: SystemAudioConfig,
    title: string,
    source?: "record" | "meeting",
    captureMode?: CaptureMode,
    areaRect?: AreaRect | null
  ) => Promise<void>;
  stop: () => Promise<{ id: string } | null>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  restart: () => Promise<void>;
  discard: () => Promise<void>;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  recording: false,
  paused: false,
  busy: false,
  stopping: false,
  error: null,
  title: "Untitled recording",
  source: "record",
  saveStatus: null,

  dismissSaveStatus() {
    set({ saveStatus: null });
  },

  async cancelSave() {
    const status = get().saveStatus;
    if (!status || status.status !== "processing") return;
    const cancelled = await window.api.recording.cancelSave(status.id);
    if (cancelled) {
      set((s) => (s.saveStatus?.id === status.id ? { saveStatus: { ...status, status: "cancelled" } } : {}));
    }
  },

  async start(targetId, overlay, mic, systemAudio, title, source = "record", captureMode = "display", areaRect = null) {
    if (get().busy || get().recording) return;
    set({ busy: true, error: null, title, source });
    try {
      await recordingService.start(targetId, overlay, mic, systemAudio, captureMode, areaRect);
      lastStartArgs = { targetId, overlay, mic, systemAudio, title, source, captureMode, areaRect };
      set({ recording: true, paused: false });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  },

  async stop() {
    if (get().busy || !get().recording) return null;
    set({ busy: true, stopping: true });
    try {
      const result = await recordingService.stop(get().title, get().source);
      lastStartArgs = null;
      set({
        recording: false,
        paused: false,
        saveStatus: result ? { id: result.id, status: "processing", percent: 0 } : null,
      });
      return result;
    } catch (e) {
      set({ error: String(e) });
      return null;
    } finally {
      set({ busy: false, stopping: false });
    }
  },

  async pause() {
    if (!get().recording || get().paused) return;
    await recordingService.pause();
    set({ paused: true });
  },

  async resume() {
    if (!get().recording || !get().paused) return;
    await recordingService.resume();
    set({ paused: false });
  },

  async restart() {
    if (get().busy || !get().recording || !lastStartArgs) return;
    const args = lastStartArgs;
    set({ busy: true, error: null, title: args.title, source: args.source });
    try {
      await recordingService.discard();
      set({ recording: false, paused: false });
      await recordingService.start(args.targetId, args.overlay, args.mic, args.systemAudio, args.captureMode, args.areaRect);
      set({ recording: true, paused: false });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  },

  async discard() {
    if (get().busy || !get().recording) return;
    set({ busy: true, error: null });
    try {
      await recordingService.discard();
      lastStartArgs = null;
      set({ recording: false, paused: false, saveStatus: null });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ busy: false });
    }
  },
}));

export function useSavingRecording(): boolean {
  return useRecordingStore((s) => s.stopping || s.saveStatus?.status === "processing");
}

async function autoTranscribeRecording(video: Video): Promise<void> {
  const settings = await SettingsService.getAutoTranscribeSettings();
  if (!settings.all && !settings.recording) return;
  try {
    const transcript = await TranscriptionService.transcribe(video.filePath);
    const updated = await LibraryService.setTranscript(video.id, transcript);
    queryClient.invalidateQueries({ queryKey: ["videos"] });
    queryClient.setQueryData(["video", updated.id], updated);
  } catch {
  }
}

let watching = false;

export function watchRecordingSaves(): void {
  if (watching) return;
  watching = true;

  window.api.recording.onSaveProgress(({ id, percent }) => {
    useRecordingStore.setState((s) =>
      s.saveStatus?.id === id && s.saveStatus.status === "processing"
        ? { saveStatus: { ...s.saveStatus, percent } }
        : {}
    );
  });

  window.api.recording.onSaveCompleted((video) => {
    useRecordingStore.setState((s) =>
      s.saveStatus?.id === video.id ? { saveStatus: { id: video.id, status: "ready", percent: 100 } } : {}
    );
    if (!video.transcript) void autoTranscribeRecording(video);
  });

  window.api.recording.onSaveFailed(({ id, message }) => {
    useRecordingStore.setState((s) =>
      s.saveStatus?.id === id ? { saveStatus: { id, status: "failed", percent: 0, message } } : {}
    );
  });
}
