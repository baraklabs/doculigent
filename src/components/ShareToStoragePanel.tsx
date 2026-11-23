import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  useDeleteStorageFile,
  useGenerateShareLink,
  useStorageFiles,
  useStoragePreference,
  useUploadStorageFile,
} from "../hooks/useStorage";
import { uniqueFileName } from "../lib/uniqueFileName";
import { isUploadCancelled } from "../lib/uploadCancel";
import { useToast } from "../hooks/useToast";
import "./ShareToStoragePanel.css";

function extOf(filePath: string): string {
  const idx = filePath.lastIndexOf(".");
  return idx >= 0 ? filePath.slice(idx) : "";
}

export function ShareToStoragePanel({
  video,
  onClose,
  autoShare,
  modal,
  headless,
}: {
  video?: { filePath: string; title: string };
  onClose?: () => void;
  /** Render as a centred popup (with backdrop) instead of an inline block. */
  modal?: boolean;
  /** No panel at all: just upload (use with autoShare), toast the result and call onClose. The
   *  only UI that can appear is the "Replace existing file?" confirmation. */
  headless?: boolean;
  /** Fires the same upload the "Upload & copy link" button does, once, as soon as
   *  `video` is loaded — used by RecordingSaveToast's "storage is set up, go share it"
   *  path so it doesn't need a manual click. */
  autoShare?: boolean;
}) {
  const toast = useToast();
  const uploadFile = useUploadStorageFile();
  const generateLink = useGenerateShareLink();
  const deleteFile = useDeleteStorageFile("");
  const { data: storagePreference } = useStoragePreference();
  // Where the upload lands: the provider and the folder path inside it.
  const providerLabel =
    storagePreference?.provider === "s3" ? "S3" : storagePreference?.provider === "google_drive" ? "Google Drive" : "your storage";
  const folder =
    storagePreference?.provider === "s3"
      ? storagePreference.s3?.folder
      : storagePreference?.provider === "google_drive"
        ? storagePreference.googleDrive?.folder
        : undefined;
  const folderPath = `${folder || "Doculigent"}/shared/`;
  const { data: sharedFiles = [] } = useStorageFiles("");
  const [error, setError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  // True from the moment Upload starts until it fails — covers the gap after the upload finishes
  // but before the link is generated/copied, so the popup doesn't reappear in between.
  const [busy, setBusy] = useState(false);
  const [linkInfo, setLinkInfo] = useState<{ expiresAt: string | null } | null>(null);
  const uploadPercent = uploadFile.uploadPercent;

  const displayName = video ? `${video.title}${extOf(video.filePath)}` : "";
  const willReplace = !!video && sharedFiles.some((f) => f.name === displayName);

  /** "new": no clash. "replace": upload, then delete the old same-named file(s). "keep-both":
   *  upload under a unique name ("name (1).ext") so nothing is overwritten. */
  async function upload(mode: "new" | "replace" | "keep-both" = "new") {
    if (!video) return;
    setError(null);
    setLinkInfo(null);
    setBusy(true);
    try {
      const uploadName =
        mode === "keep-both" ? uniqueFileName(displayName, new Set(sharedFiles.map((f) => f.name))) : displayName;
      const file = await uploadFile.mutateAsync({ filePath: video.filePath, displayName: uploadName });
      if (mode === "replace") {
        // Drive keeps same-named files side by side, so the old one has to be removed explicitly.
        // (S3 overwrites the same key, so the "new" file already has the old one's id — skipped.)
        for (const old of sharedFiles.filter((f) => f.name === displayName && f.id !== file.id)) {
          await deleteFile.mutateAsync(old.id).catch(() => {});
        }
      }
      const link = await generateLink.mutateAsync(file.id);
      await navigator.clipboard.writeText(link.url);
      toast.success(
        link.expiresAt
          ? `Link copied to clipboard — expires ${new Date(link.expiresAt).toLocaleString()}`
          : "Link copied to clipboard"
      );
      setLinkInfo({ expiresAt: link.expiresAt });
      // The toast is the confirmation; popups close themselves instead of showing a success view.
      if (headless || modal) onClose?.();
    } catch (err) {
      if (isUploadCancelled(err)) {
        // The user cancelled — not an error; just close the popup.
        setBusy(false);
        toast.info("Upload cancelled");
        if (headless || modal) onClose?.();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setBusy(false);
      if (headless) {
        toast.error(message, { title: "Couldn't share" });
        onClose?.();
      }
    }
  }

  function handleShare() {
    if (willReplace) {
      setConfirmReplace(true);
      return;
    }
    void upload();
  }

  /** Replace / Keep both / Cancel — shown when a file with this name is already in Shared. */
  function replaceDialog(onCancel: () => void) {
    return (
      <div className="modal-backdrop" onClick={onCancel}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>File already exists</h2>
          <p className="muted">
            A file named "{displayName}" is already in Shared. Replace it (the old file is removed and its link stops
            working), or keep both and upload this one as a new file?
          </p>
          <div className="actions modal-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setConfirmReplace(false);
                void upload("keep-both");
              }}
            >
              Upload & keep both
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                setConfirmReplace(false);
                void upload("replace");
              }}
            >
              Replace & upload
            </button>
          </div>
        </div>
      </div>
    );
  }

  const autoSharedRef = useRef(false);
  useEffect(() => {
    if (!autoShare || autoSharedRef.current || !video) return;
    autoSharedRef.current = true;
    handleShare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoShare, video]);

  if (headless) {
    if (!confirmReplace) return null;
    return replaceDialog(() => {
      setConfirmReplace(false);
      onClose?.();
    });
  }

  const content = (
    <div className={modal ? "field share-panel in-modal" : "field share-panel"}>
      <div className="share-panel-head">
        <span>Share "{video?.title ?? "this recording"}"</span>
        {onClose && (
          <button type="button" className="icon-btn" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        )}
      </div>
      <p className="muted">
        Upload to {providerLabel} in the folder path <code>{folderPath}</code> and get an instant link.
      </p>

      {linkInfo ? (
        <>
          <p className="notice">
            Link copied to clipboard
            {linkInfo.expiresAt ? ` — expires ${new Date(linkInfo.expiresAt).toLocaleString()}` : ""}.
          </p>
          <div className="actions">
            {onClose && (
              <button type="button" className="primary" onClick={onClose}>
                Done
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="actions">
          <button type="button" className="primary" onClick={handleShare} disabled={!video || uploadPercent !== null}>
            {uploadPercent !== null ? "Uploading…" : `Upload & copy link`}
          </button>
          {onClose && (
            <button type="button" onClick={onClose} disabled={uploadPercent !== null}>
              Cancel
            </button>
          )}
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {confirmReplace && replaceDialog(() => setConfirmReplace(false))}
    </div>
  );

  if (!modal) return content;
  // While the upload runs, the global progress popup takes over — don't stack this one behind it.
  if (busy || uploadPercent !== null) return null;
  return (
    <div className="modal-backdrop" onClick={() => uploadPercent === null && onClose?.()}>
      <div className="modal share-modal" onClick={(e) => e.stopPropagation()}>
        {content}
      </div>
    </div>
  );
}
