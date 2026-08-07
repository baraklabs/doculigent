import fs from "node:fs/promises";
import type { Video } from "@shared/types/models";
import * as libraryStore from "../native/libraryStore";
import { importVideoFiles } from "../ipc/library";
import { getActiveProvider } from "./index";

const inFlight = new Map<string, Promise<Video>>();

export function syncStorageFileToLibrary(fileId: string): Promise<Video> {
  const existing = libraryStore.getVideoBySyncedTeamFileId(fileId);
  if (existing) return Promise.resolve(existing);

  const running = inFlight.get(fileId);
  if (running) return running;

  const promise = (async () => {
    const provider = await getActiveProvider();
    const { filePath, mimeType } = await provider.downloadToTemp(fileId);
    const kind: "video" | "audio" = (mimeType ?? "").startsWith("audio/") ? "audio" : "video";
    try {
      const [video] = await importVideoFiles([filePath], kind, undefined, fileId);
      return video;
    } finally {
      await fs.rm(filePath, { force: true });
    }
  })();

  inFlight.set(fileId, promise);
  promise.finally(() => inFlight.delete(fileId));
  return promise;
}
