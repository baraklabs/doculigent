import { dialog, ipcMain } from "electron";
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

  ipcMain.handle(Channels.editProjects.delete, async (_event, id: string): Promise<void> => {
    store.deleteEditProject(id);
  });

  ipcMain.handle(Channels.editProjects.deleteMany, async (_event, ids: string[]): Promise<void> => {
    store.deleteEditProjects(ids);
  });
}
