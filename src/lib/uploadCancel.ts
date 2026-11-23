/** Message the main process throws when an upload is cancelled (it arrives wrapped by Electron's IPC). */
export const UPLOAD_CANCELLED = "Upload cancelled";

export function isUploadCancelled(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes(UPLOAD_CANCELLED);
}
