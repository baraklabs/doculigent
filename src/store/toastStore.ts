import { create } from "zustand";

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  title?: string;
  message: string;
  /** ms before auto-dismiss; 0 disables auto-dismiss (stays until manually closed). */
  duration: number;
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
      window.setTimeout(() => get().dismiss(id), duration);
    }
    return id;
  },
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, EXIT_ANIMATION_MS);
  },
}));
