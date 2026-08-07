import { useEffect, useState, type ChangeEvent, type DragEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Loader2, RefreshCw, Upload } from "lucide-react";
import type { StorageFile } from "@shared/types/storage";
import {
  useCachedShareLink,
  useDeleteStorageFile,
  useGenerateShareLink,
  useStorageFiles,
  useUploadStorageFile,
} from "../hooks/useStorage";
import { useSyncedTeamFileIds, teamErrorMessage, teamErrorStatus } from "../hooks/useTeams";
import { StorageService } from "../services/storage/StorageService";
import { useToast } from "../hooks/useToast";
import "./TeamsSection.css";

const MEDIA_EXTENSIONS = new Set([
  "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv",
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "wma",
]);

function isMediaFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  return !!ext && MEDIA_EXTENSIONS.has(ext);
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function useStorageFileSync(files: StorageFile[] | undefined): Set<string> {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: syncedFileIds = [] } = useSyncedTeamFileIds();
  const syncedIds = new Set(syncedFileIds);

  useEffect(() => {
    if (!files) return;
    for (const file of files) {
      if (syncedIds.has(file.id)) continue;
      StorageService.downloadToLibrary(file.id)
        .then(() => queryClient.invalidateQueries({ queryKey: ["teamSyncedFileIds"] }))
        .catch((err) => {
          if (teamErrorStatus(err) === 404 || /not found/i.test(teamErrorMessage(err))) return;
          toast.error(teamErrorMessage(err), { title: `Couldn't sync "${file.name}"` });
        });
    }
  }, [files, syncedFileIds]);

  return syncedIds;
}

function ShareLinkActions({ fileId }: { fileId: string }) {
  const toast = useToast();
  const { data: link, isLoading } = useCachedShareLink(fileId);
  const generateLink = useGenerateShareLink();

  async function generate() {
    try {
      await generateLink.mutateAsync(fileId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { title: "Couldn't generate link" });
    }
  }

  if (isLoading) return null;

  if (!link) {
    return (
      <button type="button" onClick={generate} disabled={generateLink.isPending}>
        <Link2 size={13} /> {generateLink.isPending ? "Generating…" : "Generate link"}
      </button>
    );
  }

  return (
    <>
      <button type="button" onClick={() => navigator.clipboard.writeText(link.url)}>
        <Copy size={13} /> Copy link
      </button>
      <button
        type="button"
        onClick={generate}
        disabled={generateLink.isPending}
        title={`Expires ${new Date(link.expiresAt).toLocaleString()}`}
      >
        <RefreshCw size={13} /> {generateLink.isPending ? "Regenerating…" : "Regenerate"}
      </button>
    </>
  );
}

/** Upload dropzone + file list + delete flow for one S3 prefix — either a team subfolder
 *  (`teams/<teamId>/`) or the untargeted `shared/` folder when teamId is "". Callers that show
 *  their own upload UI above this (e.g. ShareToStoragePanel, routed in from a video/meeting's
 *  Share button) can hide the generic dropzone via showDropzone={false} so there's only one
 *  upload control on screen at a time. */
export function StorageFileBrowser({ teamId, showDropzone = true }: { teamId: string; showDropzone?: boolean }) {
  const toast = useToast();
  const { data: files, isLoading } = useStorageFiles(teamId);
  const uploadFile = useUploadStorageFile(teamId);
  const deleteFile = useDeleteStorageFile(teamId);
  const generateLink = useGenerateShareLink();
  const syncedIds = useStorageFileSync(files);

  const [dragActive, setDragActive] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<StorageFile | null>(null);
  const [pendingReplace, setPendingReplace] = useState<{ filePaths: string[]; names: string[] } | null>(null);
  const uploadPercent = uploadFile.uploadPercent;

  async function uploadPath(filePath: string, displayName?: string): Promise<StorageFile | null> {
    try {
      return await uploadFile.mutateAsync({ filePath, displayName });
    } catch (err) {
      toast.error(teamErrorMessage(err), { title: `Couldn't upload "${displayName ?? filePath}"` });
      return null;
    }
  }

  async function uploadMany(filePaths: string[]) {
    const uploaded: StorageFile[] = [];
    for (const filePath of filePaths) {
      const file = await uploadPath(filePath);
      if (file) uploaded.push(file);
    }
    if (uploaded.length === 0) return;

    if (teamId === "" && uploaded.length === 1) {
      try {
        const link = await generateLink.mutateAsync(uploaded[0].id);
        await navigator.clipboard.writeText(link.url);
        toast.success("Link copied to clipboard");
        return;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err), { title: "Couldn't generate link" });
        return;
      }
    }

    if (teamId === "") {
      await Promise.allSettled(uploaded.map((f) => generateLink.mutateAsync(f.id)));
    }
    toast.success(`${uploaded.length} files uploaded`);
  }

  function startUpload(filePaths: string[]) {
    const existingNames = new Set((files ?? []).map((f) => f.name));
    const conflicts = filePaths.filter((p) => existingNames.has(basename(p)));
    if (conflicts.length > 0) {
      setPendingReplace({ filePaths, names: conflicts.map(basename) });
      return;
    }
    void uploadMany(filePaths);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const dropped = Array.from(e.dataTransfer.files);
    const media = dropped.filter((f) => isMediaFile(f.name));
    if (media.length < dropped.length) {
      toast.warning("Only video and audio files can be uploaded — the rest were skipped.");
    }
    if (media.length === 0) return;
    startUpload(media.map((f) => window.api.system.getPathForFile(f)));
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (chosen.length === 0) return;
    startUpload(chosen.map((f) => window.api.system.getPathForFile(f)));
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteFile.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(teamErrorMessage(err), { title: "Couldn't delete file" });
    }
  }

  return (
    <div className="field">
      <span>Files</span>

      {showDropzone && (
        <div
          className={dragActive ? "teams-dropzone drag-active" : "teams-dropzone"}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          <Upload size={20} />
          <p>Drag video or audio files here, or click to browse</p>
          <input
            type="file"
            multiple
            accept="video/*,audio/*"
            className="teams-dropzone-input"
            onChange={handleFileInputChange}
          />
        </div>
      )}

      {showDropzone && uploadPercent !== null && (
        <div className="progress">
          <div className="progress-fill" style={{ width: `${uploadPercent}%` }} />
        </div>
      )}

      {isLoading && <p className="muted">Loading…</p>}
      {!isLoading && (files ?? []).length === 0 && <p className="muted">No files here.</p>}

      <div className="model-list">
        {(files ?? []).map((f) => (
          <div key={f.id} className="model-row">
            <div className="model-row-info">
              <h3>{f.name}</h3>
              <p className="muted sub">
                {formatBytes(f.sizeBytes)} · {f.mimeType ?? "unknown type"}
              </p>
            </div>
            <div className="actions">
              {syncedIds.has(f.id) ? (
                <span className="sync-status synced">
                  <Check size={14} /> Synced
                </span>
              ) : (
                <span className="sync-status syncing">
                  <Loader2 size={14} className="spin" /> Syncing…
                </span>
              )}
              {teamId === "" && <ShareLinkActions fileId={f.id} />}
              <button type="button" className="danger" onClick={() => setDeleteTarget(f)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {deleteTarget && (
        <div className="modal-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete "{deleteTarget.name}"?</h2>
            <p className="muted">
              This removes it from S3 and deletes the synced copy from your Library. This can't be undone.
            </p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={confirmDelete} disabled={deleteFile.isPending}>
                {deleteFile.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingReplace && (
        <div className="modal-backdrop" onClick={() => setPendingReplace(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Replace existing {pendingReplace.names.length === 1 ? "file" : "files"}?</h2>
            <p className="muted">
              {pendingReplace.names.length === 1
                ? `"${pendingReplace.names[0]}" already exists here.`
                : `These files already exist here: ${pendingReplace.names.join(", ")}.`}{" "}
              Uploading will replace {pendingReplace.names.length === 1 ? "it" : "them"} — any links already shared
              will now point to the new content.
            </p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setPendingReplace(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const { filePaths } = pendingReplace;
                  setPendingReplace(null);
                  void uploadMany(filePaths);
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
