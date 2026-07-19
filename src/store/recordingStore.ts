import { create } from "zustand";
import type { MicConfig, OverlayConfig } from "@shared/types/models";
import { recordingService } from "../services/recording/RecordingService";

interface RecordingState {
  recording: boolean;
  busy: boolean;
  error: string | null;
  title: string;
  source: "record" | "meeting";
  start: (
    targetId: string,
    overlay: OverlayConfig,
    mic: MicConfig,
    title: string,
    source?: "record" | "meeting"
  ) => Promise<void>;
  /** Resolves as soon as the raw recording is handed off, not once it's fully processed
   *  — see RecordingService.stop()'s doc comment. */
  stop: () => Promise<{ id: string } | null>;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  recording: false,
  busy: false,
  error: null,
  title: "Untitled recording",
  source: "record",

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
    set({ busy: true });
    try {
      const result = await recordingService.stop(get().title, get().source);
      set({ recording: false });
      return result;
    } catch (e) {
      set({ error: String(e) });
      return null;
    } finally {
      set({ busy: false });
    }
  },
}));
