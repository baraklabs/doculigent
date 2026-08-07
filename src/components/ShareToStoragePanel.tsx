import { useState } from "react";
import { X } from "lucide-react";
import { useGenerateShareLink, useStorageFiles, useUploadStorageFile } from "../hooks/useStorage";
import { useToast } from "../hooks/useToast";
import "./ShareToStoragePanel.css";

function extOf(filePath: string): string {
  const idx = filePath.lastIndexOf(".");
  return idx >= 0 ? filePath.slice(idx) : "";
}

export function ShareToStoragePanel({
  video,
  onClose,
}: {
  video?: { filePath: string; title: string };
  onClose?: () => void;
}) {
  const toast = useToast();
  const uploadFile = useUploadStorageFile();
  const generateLink = useGenerateShareLink();
  const { data: sharedFiles = [] } = useStorageFiles("");
  const [error, setError] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const uploadPercent = uploadFile.uploadPercent;

  const displayName = video ? `${video.title}${extOf(video.filePath)}` : "";
  const willReplace = !!video && sharedFiles.some((f) => f.name === displayName);

  async function upload() {
    if (!video) return;
    setError(null);
    try {
      const file = await uploadFile.mutateAsync({ filePath: video.filePath, displayName });
      const link = await generateLink.mutateAsync(file.id);
      await navigator.clipboard.writeText(link.url);
      toast.success("Link copied to clipboard");
      onClose?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleShare() {
    if (willReplace) {
      setConfirmReplace(true);
      return;
    }
    void upload();
  }

  return (
    <div className="field share-panel">
      <div className="share-panel-head">
        <span>Share "{video?.title ?? "this recording"}"</span>
        {onClose && (
          <button type="button" className="icon-btn" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        )}
      </div>
      <p className="muted">Upload to Amazon S3 and copy a link to send a colleague.</p>

      {uploadPercent !== null && (
        <div className="progress">
          <div className="progress-fill" style={{ width: `${uploadPercent}%` }} />
        </div>
      )}

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

      {error && <p className="error">{error}</p>}

      {confirmReplace && (
        <div className="modal-backdrop" onClick={() => setConfirmReplace(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Replace existing file?</h2>
            <p className="muted">
              A file named "{displayName}" already exists in Shared. Uploading will replace it — anyone with the old
              link will now get this recording instead.
            </p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setConfirmReplace(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setConfirmReplace(false);
                  void upload();
                }}
              >
                Replace & upload
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
