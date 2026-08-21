import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Channels } from "@shared/constants/channels";
import type {
  BackgroundEditSettings,
  CameraEditSettings,
  CursorEditSettings,
  EditProject,
  EditProjectMedia,
  EditProjectSource,
  LayoutEditSettings,
  SoundEditSettings,
  TimelineEditSettings,
} from "@shared/types/models";
import { NotFoundError } from "@shared/ipc/errors";
import * as store from "../native/editProjectStore";
import { FfmpegCancelledError, transcodeExport } from "../native/ffmpeg";

interface ExportVideoInput {
  webmBytes: ArrayBuffer;
  title: string;
  durationSecs: number;
  width: number;
  height: number;
  fps: number;
}

const pendingExports = new Map<string, AbortController>();

// Deleting a project's source files can race an Edit page that still has that exact
// project open — its `<video>` elements hold the file open via an active `media://`
// request (see mediaProtocol.ts), which Windows won't let `unlink` through regardless of
// how many times deleteEditProject(s) retries. Broadcasting a release request first lets
// any window with that project open drop its video elements *before* the delete is
// attempted, rather than relying on the retry budget alone to outlast a stream that,
// while the tab stays open, never actually goes away on its own. The wait below is a
// fixed grace period, not an ack — good enough in practice (dropping `src` aborts near-
// instantly), and deleteEditProject's own retries are still the real safety net if a
// window doesn't respond in time.
function releaseMediaAndWait(ids: string[]): Promise<void> {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(Channels.editProjects.releaseMedia, ids);
  return new Promise((resolve) => setTimeout(resolve, 250));
}

export function registerEditProjectsIpc(): void {
  ipcMain.handle(Channels.editProjects.list, async (): Promise<EditProject[]> => store.listEditProjects());

  ipcMain.handle(
    Channels.editProjects.get,
    async (_event, id: string): Promise<EditProject | null> => store.getEditProject(id)
  );

  ipcMain.handle(
    Channels.editProjects.create,
    async (_event, title: string, source?: EditProjectSource): Promise<EditProject> => store.createEditProject(title, source)
  );

  ipcMain.handle(Channels.editProjects.rename, async (_event, id: string, title: string): Promise<EditProject> => {
    const updated = store.renameEditProject(id, title);
    if (!updated) throw new NotFoundError(`project ${id}`);
    return updated;
  });

  ipcMain.handle(
    Channels.editProjects.updateCamera,
    async (_event, id: string, camera: CameraEditSettings): Promise<EditProject> => {
      const updated = store.updateEditProjectCamera(id, camera);
      if (!updated) throw new NotFoundError(`project ${id}`);
      return updated;
    }
  );

  ipcMain.handle(
    Channels.editProjects.updateCursor,
    async (_event, id: string, cursor: CursorEditSettings): Promise<EditProject> => {
      const updated = store.updateEditProjectCursor(id, cursor);
      if (!updated) throw new NotFoundError(`project ${id}`);
      return updated;
    }
  );

  ipcMain.handle(
    Channels.editProjects.updateBackground,
    async (_event, id: string, background: BackgroundEditSettings): Promise<EditProject> => {
      const updated = store.updateEditProjectBackground(id, background);
      if (!updated) throw new NotFoundError(`project ${id}`);
      return updated;
    }
  );

  ipcMain.handle(
    Channels.editProjects.updateSound,
    async (_event, id: string, sound: SoundEditSettings): Promise<EditProject> => {
      const updated = store.updateEditProjectSound(id, sound);
      if (!updated) throw new NotFoundError(`project ${id}`);
      return updated;
    }
  );

  ipcMain.handle(
    Channels.editProjects.updateLayout,
    async (_event, id: string, layout: LayoutEditSettings): Promise<EditProject> => {
      const updated = store.updateEditProjectLayout(id, layout);
      if (!updated) throw new NotFoundError(`project ${id}`);
      return updated;
    }
  );

  ipcMain.handle(
    Channels.editProjects.updateTimeline,
    async (_event, id: string, timeline: TimelineEditSettings): Promise<EditProject> => {
      const updated = store.updateEditProjectTimeline(id, timeline);
      if (!updated) throw new NotFoundError(`project ${id}`);
      return updated;
    }
  );

  ipcMain.handle(Channels.editProjects.pickBackgroundImage, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Image files", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle(
    Channels.editProjects.getMedia,
    async (_event, id: string): Promise<EditProjectMedia> => store.getEditProjectMedia(id)
  );

  ipcMain.handle(Channels.editProjects.delete, async (_event, id: string, deleteSourceFiles?: boolean): Promise<void> => {
    await releaseMediaAndWait([id]);
    store.deleteEditProject(id, deleteSourceFiles);
  });

  ipcMain.handle(
    Channels.editProjects.deleteMany,
    async (_event, ids: string[], deleteSourceFiles?: boolean): Promise<void> => {
      await releaseMediaAndWait(ids);
      store.deleteEditProjects(ids, deleteSourceFiles);
    }
  );

  ipcMain.handle(
    Channels.editProjects.export,
    async (event, exportId: string, input: ExportVideoInput): Promise<{ canceled: boolean; filePath?: string }> => {
      const safeTitle = input.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Untitled project";
      const result = await dialog.showSaveDialog({
        title: "Export video",
        defaultPath: path.join(app.getPath("videos"), `${safeTitle}.mp4`),
        filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };

      const tempWebm = path.join(os.tmpdir(), `export-${exportId}.webm`);
      await fs.writeFile(tempWebm, Buffer.from(input.webmBytes));
      const abort = new AbortController();
      pendingExports.set(exportId, abort);
      try {
        await transcodeExport(
          tempWebm,
          result.filePath,
          input.width,
          input.height,
          input.fps,
          (secondsDone) => {
            if (event.sender.isDestroyed() || input.durationSecs <= 0) return;
            const percent = Math.max(0, Math.min(99, Math.round((secondsDone / input.durationSecs) * 100)));
            event.sender.send(Channels.editProjects.exportProgress, { exportId, percent });
          },
          abort.signal
        );
        return { canceled: false, filePath: result.filePath };
      } catch (e) {
        if (e instanceof FfmpegCancelledError) {
          await fs.rm(result.filePath, { force: true });
          return { canceled: true };
        }
        throw e;
      } finally {
        pendingExports.delete(exportId);
        await fs.rm(tempWebm, { force: true });
      }
    }
  );

  ipcMain.handle(Channels.editProjects.exportCancel, async (_event, exportId: string): Promise<boolean> => {
    const abort = pendingExports.get(exportId);
    if (!abort) return false;
    abort.abort();
    return true;
  });
}
