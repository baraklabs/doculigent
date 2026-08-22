import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
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
import { convertToWav, FfmpegCancelledError, type ImagePipeExportHandle, startImagePipeExport } from "../native/ffmpeg";

interface ExportBeginInput {
  title: string;
  durationSecs: number;
  width: number;
  height: number;
  fps: number;
  audioWavBytes: ArrayBuffer | null;
}

interface PendingExport {
  abort: AbortController;
  handle: ImagePipeExportHandle;
  filePath: string;
  tempWav: string | null;
  durationSecs: number;
}

const pendingExports = new Map<string, PendingExport>();

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

  // See decodeAudioToWav's own doc comment (shared/types/api.ts) — routes a source file's
  // audio through ffmpeg rather than leaving the renderer to decode it directly.
  ipcMain.handle(Channels.editProjects.decodeAudioToWav, async (_event, filePath: string): Promise<ArrayBuffer> => {
    const tempWav = path.join(os.tmpdir(), `decode-${randomUUID()}.wav`);
    try {
      await convertToWav(filePath, tempWav);
      const buf = await fs.readFile(tempWav);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } finally {
      await fs.rm(tempWav, { force: true });
    }
  });

  // Streaming export — see startImagePipeExport's own doc comment for why. exportBegin
  // opens the save dialog and spawns ffmpeg with its stdin held open, waiting for frames;
  // the renderer then streams one JPEG per exportFrame call (awaited in sequence, which is
  // this pipeline's own backpressure); exportEnd closes stdin and waits for ffmpeg to
  // finish writing the file. Call order is always exportBegin → exportFrame × N → exportEnd.
  ipcMain.handle(
    Channels.editProjects.exportBegin,
    async (event, exportId: string, input: ExportBeginInput): Promise<{ canceled: boolean }> => {
      const safeTitle = input.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Untitled project";
      const result = await dialog.showSaveDialog({
        title: "Export video",
        defaultPath: path.join(app.getPath("videos"), `${safeTitle}.mp4`),
        filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };

      const tempWav = input.audioWavBytes ? path.join(os.tmpdir(), `export-${exportId}.wav`) : null;
      if (tempWav && input.audioWavBytes) await fs.writeFile(tempWav, Buffer.from(input.audioWavBytes));

      const abort = new AbortController();
      const handle = startImagePipeExport(
        result.filePath,
        tempWav,
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
      pendingExports.set(exportId, { abort, handle, filePath: result.filePath, tempWav, durationSecs: input.durationSecs });
      return { canceled: false };
    }
  );

  ipcMain.handle(Channels.editProjects.exportFrame, async (_event, exportId: string, jpegBytes: ArrayBuffer): Promise<void> => {
    const pending = pendingExports.get(exportId);
    if (!pending) throw new NotFoundError(`export ${exportId}`);
    await pending.handle.writeFrame(Buffer.from(jpegBytes));
  });

  ipcMain.handle(
    Channels.editProjects.exportEnd,
    async (_event, exportId: string): Promise<{ canceled: boolean; filePath?: string }> => {
      const pending = pendingExports.get(exportId);
      if (!pending) throw new NotFoundError(`export ${exportId}`);
      try {
        await pending.handle.finish();
        return { canceled: false, filePath: pending.filePath };
      } catch (e) {
        if (e instanceof FfmpegCancelledError) {
          await fs.rm(pending.filePath, { force: true });
          return { canceled: true };
        }
        throw e;
      } finally {
        pendingExports.delete(exportId);
        if (pending.tempWav) await fs.rm(pending.tempWav, { force: true });
      }
    }
  );

  ipcMain.handle(Channels.editProjects.exportCancel, async (_event, exportId: string): Promise<boolean> => {
    const pending = pendingExports.get(exportId);
    if (!pending) return false;
    pending.abort.abort();
    return true;
  });
}
