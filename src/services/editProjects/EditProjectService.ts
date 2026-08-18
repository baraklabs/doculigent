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

export const EditProjectService = {
  list(): Promise<EditProject[]> {
    return window.api.editProjects.list();
  },
  get(id: string): Promise<EditProject | null> {
    return window.api.editProjects.get(id);
  },
  create(title: string, source?: EditProjectSource): Promise<EditProject> {
    return window.api.editProjects.create(title, source);
  },
  rename(id: string, title: string): Promise<EditProject> {
    return window.api.editProjects.rename(id, title);
  },
  updateCamera(id: string, camera: CameraEditSettings): Promise<EditProject> {
    return window.api.editProjects.updateCamera(id, camera);
  },
  updateCursor(id: string, cursor: CursorEditSettings): Promise<EditProject> {
    return window.api.editProjects.updateCursor(id, cursor);
  },
  updateBackground(id: string, background: BackgroundEditSettings): Promise<EditProject> {
    return window.api.editProjects.updateBackground(id, background);
  },
  updateSound(id: string, sound: SoundEditSettings): Promise<EditProject> {
    return window.api.editProjects.updateSound(id, sound);
  },
  updateLayout(id: string, layout: LayoutEditSettings): Promise<EditProject> {
    return window.api.editProjects.updateLayout(id, layout);
  },
  updateTimeline(id: string, timeline: TimelineEditSettings): Promise<EditProject> {
    return window.api.editProjects.updateTimeline(id, timeline);
  },
  pickBackgroundImage(): Promise<string | null> {
    return window.api.editProjects.pickBackgroundImage();
  },
  getMedia(id: string): Promise<EditProjectMedia> {
    return window.api.editProjects.getMedia(id);
  },
  delete(id: string): Promise<void> {
    return window.api.editProjects.delete(id);
  },
  deleteMany(ids: string[]): Promise<void> {
    return window.api.editProjects.deleteMany(ids);
  },
};
