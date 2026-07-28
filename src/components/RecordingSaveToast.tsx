import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useRecordingStore } from "../store/recordingStore";
import "./RecordingSaveToast.css";

/**
 * The recording save toast, rendered once by Layout so it's visible from any tab rather
 * than only on Record. Covers the whole handoff: an MP4-transcode progress bar while the
 * save is in flight (the tab nav is locked for exactly this window — see Layout), then a
 * green confirmation pointing at the Library.
 */
export function RecordingSaveToast() {
  const saveStatus = useRecordingStore((s) => s.saveStatus);
  const stopping = useRecordingStore((s) => s.stopping);
  const dismiss = useRecordingStore((s) => s.dismissSaveStatus);
  const cancelSave = useRecordingStore((s) => s.cancelSave);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const status = saveStatus?.status;
  const id = saveStatus?.id;
  useEffect(() => {
    if (status === "ready") queryClient.invalidateQueries({ queryKey: ["videos"] });
  }, [status, id, queryClient]);

  // Between Stop and the first progress event the capture is still being written to disk,
  // which isn't instant for a long recording. The nav is already locked here, so the toast
  // has to be up too — with an indeterminate bar, since there's no percentage yet.
  if (!saveStatus) {
    if (!stopping) return null;
    return (
      <div className="toast">
        <strong>Finishing your recording…</strong>
        <p className="muted toast-path">Writing the capture to disk.</p>
        <div className="progress progress-indeterminate" role="progressbar" aria-label="Finishing recording">
          <div className="progress-fill" />
        </div>
      </div>
    );
  }

  return (
    <div className={`toast${saveStatus.status === "ready" ? " toast-success" : ""}`}>
      {/* No dismiss while processing — the nav is locked on this same state, so letting
          the only explanation be closed would leave the lock unexplained. */}
      {saveStatus.status !== "processing" && (
        <button type="button" className="toast-close" onClick={dismiss} aria-label="Dismiss">
          ×
        </button>
      )}

      {saveStatus.status === "processing" && (
        <>
          <strong>Saving your recording…</strong>
          <p className="muted toast-path">Converting to MP4 — please stay here until it's done.</p>
          <div
            className="progress"
            role="progressbar"
            aria-valuenow={saveStatus.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Saving recording"
          >
            <div className="progress-fill" style={{ width: `${saveStatus.percent}%` }} />
          </div>
          <div className="toast-progress-foot">
            <span className="muted progress-label">{saveStatus.percent}%</span>
            <button
              type="button"
              className="danger-link"
              disabled={cancelling}
              onClick={async () => {
                setCancelling(true);
                setCancelError(null);
                try {
                  await cancelSave();
                } catch (e) {
                  // Surfaced rather than swallowed: a cancel that silently does nothing
                  // is indistinguishable from a dead button.
                  setCancelError(String(e));
                } finally {
                  setCancelling(false);
                }
              }}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          </div>
          {cancelError && <p className="error toast-path">Couldn't cancel: {cancelError}</p>}
        </>
      )}

      {saveStatus.status === "cancelled" && (
        <>
          <strong>Recording discarded</strong>
          <p className="muted toast-path">The save was cancelled.</p>
        </>
      )}

      {saveStatus.status === "ready" && (
        <>
          <strong>Recording saved</strong>
          <p className="muted toast-path">You can view and edit it from your Library.</p>
          <div className="actions">
            <button
              className="primary"
              onClick={() => {
                dismiss();
                navigate("/library");
              }}
            >
              Go to Library
            </button>
          </div>
        </>
      )}

      {saveStatus.status === "failed" && (
        <>
          <strong>Couldn't save recording</strong>
          <p className="error toast-path">{saveStatus.message}</p>
        </>
      )}
    </div>
  );
}
