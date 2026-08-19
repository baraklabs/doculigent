import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useRecordingStore } from "../store/recordingStore";
import { DEFAULT_TOAST_DURATION } from "../store/toastStore";
import "./RecordingSaveToast.css";

export function RecordingSaveToast() {
  const saveStatus = useRecordingStore((s) => s.saveStatus);
  const dismiss = useRecordingStore((s) => s.dismissSaveStatus);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const status = saveStatus?.status;
  const id = saveStatus?.id;
  useEffect(() => {
    if (status === "ready") queryClient.invalidateQueries({ queryKey: ["videos"] });
  }, [status, id, queryClient]);

  // "Recording saved" is just a confirmation + a navigation shortcut, not something that
  // needs to stick around — auto-dismiss it the same way MeetingPage's equivalent corner
  // toast already does, using the app-wide toast system's default duration for consistency.
  useEffect(() => {
    if (status !== "ready") return;
    const timer = setTimeout(dismiss, DEFAULT_TOAST_DURATION);
    return () => clearTimeout(timer);
  }, [status, id, dismiss]);

  if (!saveStatus || saveStatus.status === "processing") return null;

  return (
    <div className={`toast${saveStatus.status === "ready" ? " toast-success" : ""}`}>
      <button type="button" className="toast-close" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>

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
                navigate(`/library?section=videos&video=${id}`);
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
