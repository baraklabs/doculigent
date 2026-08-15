import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useRecordingStore } from "../store/recordingStore";
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
