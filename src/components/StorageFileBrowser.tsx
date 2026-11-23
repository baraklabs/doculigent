import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Bot, Check, Copy, Link2, Loader2, RefreshCw, Upload } from "lucide-react";
import type { StorageFile } from "@shared/types/storage";
import {
  useCachedShareLink,
  useDeleteStorageFile,
  useGenerateShareLink,
  useStorageFiles,
  useStoragePreference,
  useUploadStorageFile,
} from "../hooks/useStorage";
import { useSyncedTeamFileIds, teamErrorMessage, teamErrorStatus } from "../hooks/useTeams";
import { StorageService } from "../services/storage/StorageService";
import { LibraryService } from "../services/library/LibraryService";
import { useToast } from "../hooks/useToast";
import { Pager, paginate } from "./Pager";
import { registerUploadCancel, useUploadStore } from "../store/uploadStore";
import { isUploadCancelled } from "../lib/uploadCancel";
import { uniqueFileName } from "../lib/uniqueFileName";
import "./TeamsSection.css";

const PAGE_SIZE = 25;

type FileSortId = "newest" | "oldest" | "name-az" | "name-za" | "largest" | "smallest";
const FILE_SORT_OPTIONS: { id: FileSortId; label: string }[] = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "name-az", label: "Name A–Z" },
  { id: "name-za", label: "Name Z–A" },
  { id: "largest", label: "Largest first" },
  { id: "smallest", label: "Smallest first" },
];
const FILE_SORT_FNS: Record<FileSortId, (a: StorageFile, b: StorageFile) => number> = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  "name-az": (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
  "name-za": (a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: "base", numeric: true }),
  largest: (a, b) => b.sizeBytes - a.sizeBytes,
  smallest: (a, b) => a.sizeBytes - b.sizeBytes,
};

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
  const { data: storagePreference } = useStoragePreference();
  // Google Drive links never expire, so there's nothing to regenerate — S3 links expire after 7 days.
  const canRegenerate = storagePreference?.provider !== "google_drive";
  const generateLink = useGenerateShareLink();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { title: "Couldn't copy link" });
    }
  }

  // Google Drive links never expire, so there's no reason to make the user ask for one:
  // generate it as soon as the row has none (once per file — a failure falls back to the button).
  const autoTriedRef = useRef(false);
  useEffect(() => {
    if (autoTriedRef.current || isLoading || link || canRegenerate || !storagePreference) return;
    autoTriedRef.current = true;
    generateLink.mutate(fileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, link, canRegenerate, storagePreference, fileId]);

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
      <button type="button" className={copied ? "copy-link-btn copied" : "copy-link-btn"} onClick={() => copy(link.url)}>
        {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy link"}
      </button>
      {canRegenerate && (
        <button
          type="button"
          onClick={generate}
          disabled={generateLink.isPending}
          title={link.expiresAt ? `Expires ${new Date(link.expiresAt).toLocaleString()}` : "This link never expires"}
        >
          <RefreshCw size={13} /> {generateLink.isPending ? "Regenerating…" : "Regenerate"}
        </button>
      )}
    </>
  );
}

export function StorageFileBrowser({
  teamId,
  showDropzone = true,
  dropzoneInHeader = false,
}: {
  teamId: string;
  showDropzone?: boolean;
  /** Once files exist, float the slim dropzone to the top-right of the page header (Library > Shared). */
  dropzoneInHeader?: boolean;
}) {
  const toast = useToast();
  const { data: files, isLoading } = useStorageFiles(teamId);
  const uploadFile = useUploadStorageFile(teamId);
  const deleteFile = useDeleteStorageFile(teamId);
  const generateLink = useGenerateShareLink();
  const syncedIds = useStorageFileSync(files);
  const navigate = useNavigate();

  /** Opens the AI Assistant on this file's synced Library copy. */
  async function askAi(file: StorageFile) {
    const video = await LibraryService.get(file.id).catch(() => null);
    if (!video) {
      toast.error("This file is still syncing — try again in a moment.", { title: "Can't open AI yet" });
      return;
    }
    navigate("/ai", { state: { videoId: video.id } });
  }
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<FileSortId>("newest");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const needle = query.trim().toLowerCase();
  const allFiles = (files ?? [])
    .filter((f) => !needle || f.name.toLowerCase().includes(needle))
    .sort(FILE_SORT_FNS[sortBy]);
  const { pageCount, currentPage, pageItems: pagedFiles } = paginate(allFiles, page, PAGE_SIZE);
  useEffect(() => setPage(1), [query, sortBy]);
  // Only count selections that still exist (a deleted file drops out).
  const selectedFiles = (files ?? []).filter((f) => selectedIds.has(f.id));
  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const [dragActive, setDragActive] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<StorageFile[] | null>(null);
  const [pendingReplace, setPendingReplace] = useState<{ filePaths: string[]; names: string[] } | null>(null);
  const uploadPercent = uploadFile.uploadPercent;

  async function uploadPath(
    filePath: string,
    displayName?: string,
    batch?: { silent: boolean; onProgress: (percent: number) => void }
  ): Promise<StorageFile | null> {
    try {
      return await uploadFile.mutateAsync({ filePath, displayName, ...batch });
    } catch (err) {
      if (!isUploadCancelled(err)) {
        toast.error(teamErrorMessage(err), { title: `Couldn't upload "${displayName ?? filePath}"` });
      }
      return null;
    }
  }

  /** "replace": same-named files are deleted after their new copy uploads. "keep-both": the new
   *  copy gets a unique name ("name (1).ext"). "new": no name clashes. */
  async function uploadMany(filePaths: string[], mode: "new" | "replace" | "keep-both" = "new") {
    const takenNames = new Set((files ?? []).map((f) => f.name));
    const oldByName = new Map((files ?? []).map((f) => [f.name, f.id] as const));
    const uploaded: StorageFile[] = [];
    const total = filePaths.length;
    // Several files → ONE popup / tray card: "File 2 of 5" with a single overall progress bar,
    // instead of a popup per file.
    const batchId = total > 1 ? `batch-${crypto.randomUUID()}` : null;
    let cancelled = false;
    if (batchId) {
      useUploadStore.getState().start(batchId, `${total} files`);
      registerUploadCancel(batchId, () => {
        cancelled = true;
        uploadFile.cancelActive();
      });
    }
    for (let i = 0; i < total; i++) {
      if (cancelled) break;
      const original = basename(filePaths[i]);
      const clash = takenNames.has(original);
      const targetName = clash && mode === "keep-both" ? uniqueFileName(original, takenNames) : undefined;
      if (targetName) takenNames.add(targetName);
      const file = await uploadPath(
        filePaths[i],
        targetName,
        batchId
          ? {
              silent: true,
              onProgress: (percent) =>
                useUploadStore.getState().setProgress(batchId, ((i + percent / 100) / total) * 100, `File ${i + 1} of ${total}`),
            }
          : undefined
      );
      if (file) {
        uploaded.push(file);
        const oldId = oldByName.get(original);
        // Drive keeps same-named files side by side, so remove the old one explicitly (S3 reuses the
        // same key, so its "old" id is the new file's id — skipped).
        if (mode === "replace" && clash && oldId && oldId !== file.id) {
          await deleteFile.mutateAsync(oldId).catch(() => {});
        }
      }
    }
    if (cancelled) {
      toast.info(uploaded.length > 0 ? `Upload cancelled — ${uploaded.length} of ${total} files were uploaded` : "Upload cancelled");
      return;
    }
    if (batchId) {
      useUploadStore.getState().setProgress(batchId, 100, `File ${total} of ${total}`);
      useUploadStore.getState().finish(batchId);
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
    if (!deleteTargets) return;
    const results = await Promise.allSettled(deleteTargets.map((f) => deleteFile.mutateAsync(f.id)));
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    if (failed.length > 0) {
      toast.error(teamErrorMessage(failed[0].reason), {
        title: failed.length === 1 ? "Couldn't delete file" : `Couldn't delete ${failed.length} files`,
      });
    }
    setDeleteTargets(null);
    setSelectedIds(new Set());
  }

  // Nothing shared yet → the dropzone is the page: big and centred. Once there's at least one
  // file it shrinks to a slim line at the top and the list takes over.
  const hasFiles = (files ?? []).length > 0;
  const emptyState = !isLoading && !hasFiles;

  return (
    <div className={emptyState ? "field storage-browser storage-browser-empty" : "field storage-browser"}>

      {showDropzone && (
        <div
          className={["teams-dropzone", hasFiles && "compact", hasFiles && dropzoneInHeader && "in-header", emptyState && "centered", dragActive && "drag-active"]
            .filter(Boolean)
            .join(" ")}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          <Upload size={hasFiles ? 16 : 28} />
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


      {(files ?? []).length > 0 && (
        <div className="library-toolbar">
          <input type="search" placeholder="Search files…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="library-sort">
            <span className="muted">Sort by</span>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as FileSortId)}>
              {FILE_SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set(allFiles.map((f) => f.id)))}
            disabled={allFiles.length === 0}
          >
            Select All
          </button>
          <button type="button" onClick={() => setSelectedIds(new Set())} disabled={selectedFiles.length === 0}>
            Deselect All
          </button>
          <span className="muted library-selection-count">
            {selectedFiles.length > 0 ? `${selectedFiles.length} selected` : ""}
          </span>
          <button
            type="button"
            className="danger"
            disabled={selectedFiles.length === 0}
            onClick={() => setDeleteTargets(selectedFiles)}
          >
            Delete Selected
          </button>
          <button
            type="button"
            className="danger library-delete-all"
            disabled={(files ?? []).length === 0}
            onClick={() => setDeleteTargets(files ?? [])}
          >
            Delete All
          </button>
        </div>
      )}

      {isLoading && <p className="muted">Loading…</p>}
      {!isLoading && (files ?? []).length === 0 && <p className="muted storage-empty-msg">No files shared yet</p>}
      {!isLoading && (files ?? []).length > 0 && allFiles.length === 0 && (
        <p className="muted">No files match your search.</p>
      )}

      <div className="model-list">
        {pagedFiles.map((f) => (
          <div key={f.id} className={selectedIds.has(f.id) ? "model-row selected" : "model-row"}>
            <label className="storage-row-select">
              <input type="checkbox" checked={selectedIds.has(f.id)} onChange={() => toggleSelect(f.id)} />
            </label>
            <div className="model-row-info">
              <h3>{f.name}</h3>
              <p className="muted sub">
                {formatBytes(f.sizeBytes)} · {f.mimeType ?? "unknown type"} · Shared{" "}
                {new Date(f.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </p>
            </div>
            <div className="actions">
              <button type="button" title="Ask AI about this file" className="icon-btn icon-btn-ai" onClick={() => askAi(f)}>
                <Bot size={20} />
              </button>
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
              <button type="button" className="danger" onClick={() => setDeleteTargets([f])}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      <Pager total={allFiles.length} page={currentPage} pageCount={pageCount} onPage={setPage} />

      {deleteTargets && (
        <div className="modal-backdrop" onClick={() => setDeleteTargets(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              {deleteTargets.length === 1 ? `Delete "${deleteTargets[0].name}"?` : `Delete ${deleteTargets.length} files?`}
            </h2>
            <p className="muted">
              This removes it from your connected storage and deletes the synced copy from your Library. This can't be undone.
            </p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setDeleteTargets(null)}>
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
            <h2>{pendingReplace.names.length === 1 ? "File already exists" : "Files already exist"}</h2>
            <p className="muted">
              {pendingReplace.names.length === 1
                ? `"${pendingReplace.names[0]}" is already here.`
                : `These are already here: ${pendingReplace.names.join(", ")}.`}{" "}
              Replace {pendingReplace.names.length === 1 ? "it" : "them"} (the old {pendingReplace.names.length === 1 ? "file is" : "files are"} removed and
              existing links stop working), or keep both and upload as new {pendingReplace.names.length === 1 ? "file" : "files"}?
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
                  void uploadMany(filePaths, "keep-both");
                }}
              >
                Upload & keep both
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const { filePaths } = pendingReplace;
                  setPendingReplace(null);
                  void uploadMany(filePaths, "replace");
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
