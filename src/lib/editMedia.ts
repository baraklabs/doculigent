import { mediaKindForPath, mediaUrl } from "@shared/constants/media";
import type { EditProjectMediaItem } from "@shared/types/models";

/** Just the file name out of an absolute path, either separator — the added-media pool
 *  keeps the full path for playback and shows this instead, since a project's Media panel
 *  is far too narrow for the real thing. */
export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/** How long a file added to the media pool actually is, measured by loading its metadata
 *  into a throwaway (never-inserted) element. Done here in the renderer rather than in the
 *  main process because the same media:// pipeline that plays the file can measure it, with
 *  no second decoder involved — and a length has to be known up front, since dropping a
 *  file onto a track places a piece spanning its whole duration immediately.
 *
 *  Resolves 0 for anything that won't load (missing/unsupported file, or a metadata load
 *  that never settles — hence the timeout): the item is still added to the pool, it just
 *  can't have a piece placed from it, which reads correctly as "this file isn't playable
 *  here" rather than silently dropping it from the panel. */
export function probeMediaDurationMs(filePath: string, kind: "audio" | "video"): Promise<number> {
  return new Promise((resolve) => {
    const el = kind === "video" ? document.createElement("video") : new Audio();
    let settled = false;
    function done(ms: number) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      resolve(ms);
    }
    const timer = window.setTimeout(() => done(0), 10_000);
    el.preload = "metadata";
    el.addEventListener("loadedmetadata", () => done(Number.isFinite(el.duration) ? el.duration * 1000 : 0), { once: true });
    el.addEventListener("error", () => done(0), { once: true });
    el.src = mediaUrl(filePath);
  });
}

/** Turns picked/dropped file paths into pool entries, measuring each one's length as it
 *  goes (all in parallel — these are metadata-only loads). Anything that's neither an audio
 *  nor a video file by extension is dropped silently, which is what makes it safe to hand
 *  this a raw OS drag-and-drop's file list. */
export async function buildMediaItems(filePaths: string[]): Promise<EditProjectMediaItem[]> {
  const candidates = filePaths
    .map((filePath) => ({ filePath, kind: mediaKindForPath(filePath) }))
    .filter((c): c is { filePath: string; kind: "audio" | "video" } => c.kind !== null);
  return Promise.all(
    candidates.map(async ({ filePath, kind }) => ({
      id: crypto.randomUUID(),
      name: baseName(filePath),
      filePath,
      kind,
      durationMs: await probeMediaDurationMs(filePath, kind),
    }))
  );
}
