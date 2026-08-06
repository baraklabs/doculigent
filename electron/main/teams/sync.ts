
import fs from "node:fs/promises";
import type { Video } from "@shared/types/models";
import * as libraryStore from "../native/libraryStore";
import { downloadTeamFileToTemp } from "./download";
import { importVideoFiles } from "../ipc/library";

const inFlight = new Map<string, Promise<Video>>();

export function syncTeamFileToLibrary(teamId: string, fileId: string): Promise<Video> {
  const existing = libraryStore.getVideoBySyncedTeamFileId(fileId);
  if (existing) return Promise.resolve(existing);

  const running = inFlight.get(fileId);
  if (running) return running;

  const promise = (async () => {
    const { filePath, kind } = await downloadTeamFileToTemp(fileId);
    try {
      const [video] = await importVideoFiles([filePath], kind, undefined, fileId, teamId);
      return video;
    } finally {
      await fs.rm(filePath, { force: true });
    }
  })();

  inFlight.set(fileId, promise);
  promise.finally(() => inFlight.delete(fileId));
  return promise;
}
