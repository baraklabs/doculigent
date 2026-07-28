import { DEFAULT_TOAST_DURATION, useToastStore, type ToastVariant } from "../store/toastStore";

interface NotifyOptions {
  title?: string;
  /** ms before auto-dismiss; 0 disables auto-dismiss. Defaults to 5s. */
  duration?: number;
}

/** The app-wide toast API — call `useToast().success("Saved")` etc. from any page.
 *  Toasts stack (rendered once, globally, by <ToastStack /> in Layout) and auto-dismiss
 *  unless duration is set to 0. */
export function useToast() {
  const push = useToastStore((s) => s.push);
  const dismiss = useToastStore((s) => s.dismiss);

  function notify(variant: ToastVariant, message: string, options?: NotifyOptions): string {
    return push({
      variant,
      message,
      title: options?.title,
      duration: options?.duration ?? DEFAULT_TOAST_DURATION,
    });
  }

  return {
    success: (message: string, options?: NotifyOptions) => notify("success", message, options),
    error: (message: string, options?: NotifyOptions) => notify("error", message, options),
    warning: (message: string, options?: NotifyOptions) => notify("warning", message, options),
    info: (message: string, options?: NotifyOptions) => notify("info", message, options),
    dismiss,
  };
}
