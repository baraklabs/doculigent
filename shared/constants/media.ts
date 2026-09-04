/**
 * Custom protocol for serving local video files to the renderer's <video> tags. A raw
 * `file://` src works inconsistently from the renderer's http(dev)/file(prod) origin and
 * gives no seek support; routing through Electron's `net.fetch` (see
 * electron/main/mediaProtocol.ts) gives Range-request/seeking support for free, the same
 * as a normal https video URL.
 */
export const MEDIA_SCHEME = "doculigent-media";

export function mediaUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://file/${encodeURIComponent(filePath)}`;
}

/** File extensions the Edit page's Media panel accepts, split by which Timeline track a
 *  picked file lands on. Shared by the main process (the open dialog's own filters — see
 *  ipc/editProjects.ts's pickMediaFiles) and the renderer (classifying an OS drag-and-drop
 *  onto a track, which never goes through that dialog), so the two can't drift apart.
 *  Lower-case, leading dot, matching what path.extname returns. */
export const MEDIA_VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".wmv", ".flv"] as const;
export const MEDIA_AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".wma"] as const;

/** Which track a file belongs on, from its extension alone — null for anything that's
 *  neither (a dropped PDF, a folder, …), which callers drop silently. */
export function mediaKindForPath(filePath: string): "audio" | "video" | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filePath.slice(dot).toLowerCase();
  if ((MEDIA_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return "video";
  if ((MEDIA_AUDIO_EXTENSIONS as readonly string[]).includes(ext)) return "audio";
  return null;
}
