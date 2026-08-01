import { create } from "zustand";
import type { MicConfig, OverlayConfig, Video } from "@shared/types/models";
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

interface RecordingState {
  recording: boolean;
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
    title: string,
    source?: "record" | "meeting"
  ) => Promise<void>;
  stop: () => Promise<{ id: string } | null>;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  recording: false,
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

  async start(targetId, overlay, mic, title, source = "record") {
    if (get().busy || get().recording) return;
    set({ busy: true, error: null, title, source });
    try {
      await recordingService.start(targetId, overlay, mic);
      set({ recording: true });
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
      set({
        recording: false,
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
    // Best-effort — the recording is already saved either way; the user can still
    // transcribe it by hand from the Library if this fails (e.g. no model configured).
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
    // Meeting-source saves already carry a transcript (built live during the call, see
    // MeetingPage's transcribePcm usage) — only plain screen recordings land here untranscribed.
    if (!video.transcript) void autoTranscribeRecording(video);
  });

  window.api.recording.onSaveFailed(({ id, message }) => {
    useRecordingStore.setState((s) =>
      s.saveStatus?.id === id ? { saveStatus: { id, status: "failed", percent: 0, message } } : {}
    );
  });
}
