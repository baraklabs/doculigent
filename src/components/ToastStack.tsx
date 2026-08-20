import { useToastStore } from "../store/toastStore";
import "./ToastStack.css";

const ICONS: Record<string, string> = { success: "✓", error: "✕", warning: "⚠", info: "ℹ" };

/** Renders every active toast, stacked top-right — mount once, globally (see Layout). */
export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const pauseTimer = useToastStore((s) => s.pauseTimer);
  const resumeTimer = useToastStore((s) => s.resumeTimer);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" aria-live="polite">
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
  );
}
