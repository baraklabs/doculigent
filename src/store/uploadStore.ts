import { create } from "zustand";

export interface UploadTask {
  id: string;
  name: string;
  /** "upload" = sending to storage; "import" = adding files to the Library. */
  kind: "upload" | "import";
  /** Extra line under the name, e.g. "File 2 of 3" for a multi-file import. */
  detail?: string;
  percent: number;
  status: "uploading" | "done" | "error";
  error?: string;
  /** False → shown as the centred modal; true → shrunk into the bottom-right tray. */
  minimized: boolean;
}

/** Cancel handlers live outside the store (functions aren't state). A task with none can't be cancelled. */
const cancelHandlers = new Map<string, () => void>();
export function registerUploadCancel(id: string, handler: () => void): void {
  cancelHandlers.set(id, handler);
}
export function canCancelUpload(id: string): boolean {
  return cancelHandlers.has(id);
}
/** Cancels an in-flight upload and drops its popup / tray card straight away. */
export function cancelUpload(id: string): void {
  cancelHandlers.get(id)?.();
  cancelHandlers.delete(id);
  useUploadStore.getState().dismiss(id);
}

interface UploadState {
  tasks: UploadTask[];
  start: (id: string, name: string, kind?: "upload" | "import") => void;
  setProgress: (id: string, percent: number, detail?: string) => void;
  /** Progress for whichever Library import is running (there's only ever one at a time). */
  setImportProgress: (percent: number, detail?: string) => void;
  finish: (id: string, error?: string) => void;
  minimize: (id: string) => void;
  /** Bring a tray card back up as the modal (any other open modal drops to the tray). */
  restore: (id: string) => void;
  dismiss: (id: string) => void;
  /** Clears every finished / failed card; uploads still in progress are never touched. */
  dismissFinished: () => void;
}

/** How long a finished upload's card lingers in the tray (showing its green tick). */
const DONE_LINGER_MS = 2500;

/** Tracks every in-flight storage upload app-wide, so progress survives switching tabs. */
export const useUploadStore = create<UploadState>((set, get) => ({
  tasks: [],

  start: (id, name, kind = "upload") =>
    set((s) => ({
      // The newest upload takes the modal; whatever was open drops into the tray.
      tasks: [
        ...s.tasks.map((t) => ({ ...t, minimized: true })),
        { id, name, kind, percent: 0, status: "uploading", minimized: false },
      ],
    })),

  setProgress: (id, percent, detail) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id && t.status === "uploading" ? { ...t, percent, detail: detail ?? t.detail } : t)),
    })),

  setImportProgress: (percent, detail) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.kind === "import" && t.status === "uploading" ? { ...t, percent, detail: detail ?? t.detail } : t
      ),
    })),

  finish: (id, error) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === id
          ? error
            ? // A failure goes to the tray so it's seen (and stays until dismissed).
              { ...t, status: "error", error, minimized: true }
            : { ...t, status: "done", percent: 100 }
          : t
      ),
    }));
    if (!error) {
      // A finished upload closes its modal straight away, and its tray card fades after a moment.
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, minimized: true } : t)) }));
      setTimeout(() => get().dismiss(id), DONE_LINGER_MS);
    }
  },

  minimize: (id) => set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, minimized: true } : t)) })),

  restore: (id) =>
    set((s) => ({ tasks: s.tasks.map((t) => ({ ...t, minimized: t.id === id ? false : true })) })),

  dismiss: (id) => {
    cancelHandlers.delete(id);
    set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
  },

  dismissFinished: () => set((s) => ({ tasks: s.tasks.filter((t) => t.status === "uploading") })),
}));
