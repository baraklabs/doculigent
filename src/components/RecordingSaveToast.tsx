import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useRecordingStore } from "../store/recordingStore";
import { useAuthStore } from "../store/authStore";
import { DEFAULT_TOAST_DURATION } from "../store/toastStore";
import { useToast } from "../hooks/useToast";
import { useStoragePreference } from "../hooks/useStorage";
import { isStorageNotSetUp, showStorageSetupToast } from "../lib/storageSetupToast";
import "./RecordingSaveToast.css";

export function RecordingSaveToast() {
  const saveStatus = useRecordingStore((s) => s.saveStatus);
  const dismiss = useRecordingStore((s) => s.dismissSaveStatus);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: storagePreference } = useStoragePreference();
  const session = useAuthStore((s) => s.session);
  const authReady = useAuthStore((s) => s.ready);
  const storageNotSetUp = isStorageNotSetUp(storagePreference, session, authReady);

  const status = saveStatus?.status;
  const id = saveStatus?.id;
  const result = saveStatus?.result;
  useEffect(() => {
    if (status === "ready") queryClient.invalidateQueries({ queryKey: ["videos"] });
  }, [status, id, queryClient]);

  // "Recording saved" goes through the app-wide toaster (stacking, hover-pauses,
  // supports an action link) instead of its own bespoke corner popup — the popup below
  // is now only for "cancelled"/"failed", which don't need a Library shortcut.
  const savedToastRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "ready" || savedToastRef.current === id) return;
    savedToastRef.current = id ?? null;
    toast.success(
      result?.kind === "editProject"
        ? "You can find it in the Projects section of your Library."
        : "You can view and edit it from your Library.",
      {
        title: "Recording saved",
        action:
          result?.kind === "video"
            ? { label: "Go to Library", onClick: () => navigate(`/library?section=videos&video=${result.video.id}`) }
            : undefined,
      }
    );
    dismiss();
  }, [status, id, result, toast, navigate, dismiss]);

  // Advanced Recording: open the editor automatically — there's no composited video to
  // browse to, the whole point of Advanced is to land straight in editing.
  const openedEditorRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "ready" || result?.kind !== "editProject" || openedEditorRef.current === id) return;
    openedEditorRef.current = id ?? null;
    navigate(`/edit/${result.editProjectId}`);
  }, [status, id, result, navigate]);

  // Quick Recording: this is the "instant share" mode's other half — either nudge the
  // user to set up storage, or skip the manual click entirely and jump straight into the
  // normal share/upload flow (see ShareToStoragePanel.tsx / SharePage.tsx's `autoShare`).
  const autoShareRef = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "ready" || result?.kind !== "video" || autoShareRef.current === id) return;
    autoShareRef.current = id ?? null;
    if (storageNotSetUp) {
      showStorageSetupToast(toast, navigate);
    } else {
      navigate(`/library/${result.video.id}/share?autoShare=1`);
    }
  }, [status, id, result, storageNotSetUp, toast, navigate]);

  // "Recording discarded" is just a confirmation with nothing to act on — auto-dismiss it
  // the same way MeetingPage's equivalent corner toast already does. "failed" stays
  // manual-dismiss since it carries an error message worth reading at the user's own pace.
  useEffect(() => {
    if (status !== "cancelled") return;
    const timer = setTimeout(dismiss, DEFAULT_TOAST_DURATION);
    return () => clearTimeout(timer);
  }, [status, id, dismiss]);

  if (!saveStatus || saveStatus.status === "processing" || saveStatus.status === "ready") return null;

  return (
    <div className="toast">
      <button type="button" className="toast-close" onClick={dismiss} aria-label="Dismiss">
        ×
      </button>

      {saveStatus.status === "cancelled" && (
        <>
          <strong>Recording discarded</strong>
          <p className="muted toast-path">The save was cancelled.</p>
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
