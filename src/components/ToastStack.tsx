import { useToastStore } from "../store/toastStore";
import { useUploadStore } from "../store/uploadStore";
import { UploadCards, UploadModal, useUploadProgressFeed } from "./UploadTray";
import "./ToastStack.css";

const ICONS: Record<string, string> = { success: "✓", error: "✕", warning: "⚠", info: "ℹ" };

/** Renders every active toast, stacked top-right — mount once, globally (see Layout). */
export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const pauseTimer = useToastStore((s) => s.pauseTimer);
  const resumeTimer = useToastStore((s) => s.resumeTimer);

  useUploadProgressFeed();
  const hasTrayCards = useUploadStore((s) => s.tasks.some((t) => t.minimized));
  const finishedCount = useUploadStore((s) => s.tasks.filter((t) => t.status !== "uploading").length);
  const dismissFinishedUploads = useUploadStore((s) => s.dismissFinished);
  const dismissAllToasts = useToastStore((s) => s.dismissAll);
  // Everything that can be cleared: toasts + finished/failed uploads (in-progress ones stay).
  const clearableCount = toasts.filter((t) => !t.leaving).length + finishedCount;

  return (
    <>
      <UploadModal />
      {(toasts.length > 0 || hasTrayCards) && (
    <div className="toast-stack" aria-live="polite">
      {clearableCount > 1 && (
        <button
          type="button"
          className="toast-dismiss-all"
          onClick={() => {
            dismissAllToasts();
            dismissFinishedUploads();
          }}
        >
          Dismiss all
        </button>
      )}
      {/* Background uploads sit in the same bottom-right stack as toasts. */}
      <UploadCards />
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast-item toast-item-${t.variant}${t.leaving ? " leaving" : ""}`}
          role="status"
          onMouseEnter={() => pauseTimer(t.id)}
          onMouseLeave={() => resumeTimer(t.id)}
        >
          <span className="toast-item-icon">{ICONS[t.variant]}</span>
          <div className="toast-item-body">
            {t.title && <strong>{t.title}</strong>}
            <p>{t.message}</p>
            {t.action && (
              <button
                type="button"
                className="toast-item-action"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button type="button" className="toast-item-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
      )}
    </>
  );
}
