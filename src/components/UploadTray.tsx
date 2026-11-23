import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Maximize2, Minimize2, X } from "lucide-react";
import { StorageService } from "../services/storage/StorageService";
import { LibraryService } from "../services/library/LibraryService";
import { cancelUpload, canCancelUpload, useUploadStore, type UploadTask } from "../store/uploadStore";
import "./UploadTray.css";

/** Keep in step with the .upload-modal.shrinking animation length in UploadTray.css. */
const SHRINK_MS = 320;

/** Feeds every storage upload's progress into the store — mount once, globally (see Layout). */
export function useUploadProgressFeed(): void {
  const setProgress = useUploadStore((s) => s.setProgress);
  const setImportProgress = useUploadStore((s) => s.setImportProgress);
  useEffect(() => StorageService.onUploadProgress(({ uploadId, percent }) => setProgress(uploadId, percent)), [setProgress]);
  // Library imports report progress through their own channel; feeding it here (not from the
  // Library page) keeps it updating after you leave that page.
  useEffect(
    () =>
      LibraryService.onImportProgress(({ percent, fileIndex, totalFiles }) =>
        setImportProgress(
          percent,
          totalFiles > 1 ? `File ${Math.min(fileIndex + 1, totalFiles)} of ${totalFiles}` : undefined
        )
      ),
    [setImportProgress]
  );
}

/** The centred progress popup for the one upload that isn't minimised. */
export function UploadModal() {
  const task = useUploadStore((s) => s.tasks.find((t) => !t.minimized && t.status === "uploading"));
  const minimize = useUploadStore((s) => s.minimize);
  const [shrinkingId, setShrinkingId] = useState<string | null>(null);
  const taskId = task?.id ?? null;

  const runInBackground = useCallback(() => {
    if (!taskId) return;
    setShrinkingId(taskId);
    // Let the shrink-toward-the-corner animation play, then hand over to the tray card.
    setTimeout(() => {
      minimize(taskId);
      setShrinkingId(null);
    }, SHRINK_MS);
  }, [taskId, minimize]);

  // The popup doesn't block the app: the first click anywhere outside it (a tab, a button, the
  // page itself) sends it down to the tray and the click goes through as normal.
  useEffect(() => {
    if (!taskId || shrinkingId) return;
    function onPointerDown(e: PointerEvent) {
      if ((e.target as Element | null)?.closest?.(".upload-modal")) return;
      runInBackground();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [taskId, shrinkingId, runInBackground]);

  if (!task) return null;
  const shrinking = shrinkingId === task.id;

  return (
    <div className={shrinking ? "upload-modal-backdrop shrinking" : "upload-modal-backdrop"}>
      <div className={shrinking ? "upload-modal shrinking" : "upload-modal"} role="dialog" aria-label="Uploading">
        <button type="button" className="upload-icon-btn upload-modal-min" title="Run in background" onClick={runInBackground}>
          <Minimize2 size={16} />
        </button>
        <h2>{task.kind === "import" ? "Importing…" : "Uploading…"}</h2>
        <p className="muted upload-name" title={task.name}>
          {task.name}
        </p>
        {task.detail && <p className="muted upload-detail">{task.detail}</p>}
        <div className="upload-track">
          <div className="upload-fill" style={{ width: `${task.percent}%` }} />
        </div>
        <p className="muted upload-percent">{Math.round(task.percent)}%</p>
        <div className="upload-modal-actions">
          {canCancelUpload(task.id) && (
            <button type="button" className="upload-cancel-btn" onClick={() => cancelUpload(task.id)}>
              Cancel upload
            </button>
          )}
          <button type="button" className="upload-bg-btn" onClick={runInBackground}>
            <Minimize2 size={14} /> Run in background
          </button>
        </div>
      </div>
    </div>
  );
}

function UploadCard({ task }: { task: UploadTask }) {
  const restore = useUploadStore((s) => s.restore);
  const dismiss = useUploadStore((s) => s.dismiss);
  return (
    <div className={`upload-card upload-card-${task.status}`} role="status">
      <span className="upload-card-icon">
        {task.status === "done" ? <Check size={15} /> : task.status === "error" ? <X size={15} /> : <Loader2 size={15} className="spin" />}
      </span>
      <div className="upload-card-body">
        <strong title={task.name}>{task.name}</strong>
        {task.status === "error" ? (
          <p className="upload-card-error">{task.error}</p>
        ) : (
          <>
            <div className="upload-track upload-track-sm">
              <div className="upload-fill" style={{ width: `${task.percent}%` }} />
            </div>
            <p className="muted upload-card-sub">
              {task.status === "done"
                ? task.kind === "import"
                  ? "Imported"
                  : "Uploaded"
                : `${task.detail ? `${task.detail} · ` : ""}${Math.round(task.percent)}%`}
            </p>
          </>
        )}
      </div>
      {task.status === "uploading" && (
        <>
          <button type="button" className="upload-icon-btn" title="Expand" onClick={() => restore(task.id)}>
            <Maximize2 size={14} />
          </button>
          {canCancelUpload(task.id) && (
            <button type="button" className="upload-icon-btn upload-cancel-icon" title="Cancel upload" onClick={() => cancelUpload(task.id)}>
              <X size={14} />
            </button>
          )}
        </>
      )}
      {task.status !== "uploading" && (
        <button type="button" className="upload-icon-btn" title="Dismiss" onClick={() => dismiss(task.id)}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Minimised / finished uploads, one card per upload, stacked above one another. */
export function UploadCards() {
  const tasks = useUploadStore((s) => s.tasks.filter((t) => t.minimized));
  if (tasks.length === 0) return null;
  return (
    <>
      {tasks.map((t) => (
        <UploadCard key={t.id} task={t} />
      ))}
    </>
  );
}
