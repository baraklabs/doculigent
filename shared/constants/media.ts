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
