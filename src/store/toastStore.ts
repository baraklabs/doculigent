import { create } from "zustand";

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  title?: string;
  message: string;
  /** ms before auto-dismiss; 0 disables auto-dismiss (stays until manually closed). */
  duration: number;
  /** Optional inline call-to-action rendered as a link-style button in the toast. */
  action?: ToastAction;
  /** True while the exit animation plays, just before actual removal. */
  leaving?: boolean;
}

export const DEFAULT_TOAST_DURATION = 5000;
/** Must match the CSS exit animation's duration in ToastStack.css. */
const EXIT_ANIMATION_MS = 200;

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, "id" | "leaving"> & { id?: string }) => string;
  dismiss: (id: string) => void;
  /** Stops the auto-dismiss countdown (e.g. while the pointer is hovering it). */
  pauseTimer: (id: string) => void;
  /** Restarts the auto-dismiss countdown from wherever it left off when paused. */
  resumeTimer: (id: string) => void;
}

/** Auto-dismiss timers live outside the store, keyed by toast id — they're an imperative
 *  side effect (setTimeout handles), not serializable state a component should re-render
 *  from. `remainingMs`/`startedAt` let pauseTimer/resumeTimer stop and restart the same
 *  countdown from where it left off, rather than resetting to the full duration on every
 *  hover out (which would let a reader who dips in and out of hovering keep a toast alive
 *  indefinitely without ever actually reading it fully unpaused). */
const timers = new Map<string, { timeoutId: number; remainingMs: number; startedAt: number }>();

function clearTimer(id: string): void {
  const t = timers.get(id);
  if (t) {
    window.clearTimeout(t.timeoutId);
    timers.delete(id);
  }
}

/** A stacking, auto-dismissing notification list — any page can push onto it via useToast()
 *  rather than hand-rolling its own timer + dismiss state (see MeetingPage's old mic
 *  warning, since migrated onto this). */
export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast) => {
    const id = toast.id ?? crypto.randomUUID();
    const duration = toast.duration ?? DEFAULT_TOAST_DURATION;
    set((s) => ({ toasts: [...s.toasts, { ...toast, id, duration }] }));
    if (duration > 0) {
      timers.set(id, { timeoutId: window.setTimeout(() => get().dismiss(id), duration), remainingMs: duration, startedAt: Date.now() });
    }
    return id;
  },
  dismiss: (id) => {
    clearTimer(id);
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, EXIT_ANIMATION_MS);
  },
  pauseTimer: (id) => {
    const t = timers.get(id);
    if (!t) return;
    window.clearTimeout(t.timeoutId);
    t.remainingMs = Math.max(0, t.remainingMs - (Date.now() - t.startedAt));
  },
  resumeTimer: (id) => {
    const t = timers.get(id);
    if (!t) return;
    t.startedAt = Date.now();
    t.timeoutId = window.setTimeout(() => get().dismiss(id), t.remainingMs);
  },
}));
