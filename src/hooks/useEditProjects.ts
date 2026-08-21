import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { EditProjectService } from "../services/editProjects/EditProjectService";

export function useEditProjects() {
  return useQuery<EditProject[]>({ queryKey: ["editProjects"], queryFn: () => EditProjectService.list() });
}

export function useEditProject(id: string | undefined) {
  return useQuery<EditProject | null>({
    queryKey: ["editProject", id],
    queryFn: () => (id ? EditProjectService.get(id) : Promise.resolve(null)),
    enabled: !!id,
  });
}

export function useEditProjectMedia(id: string | undefined) {
  return useQuery<EditProjectMedia>({
    queryKey: ["editProjectMedia", id],
    queryFn: () => EditProjectService.getMedia(id!),
    enabled: !!id,
  });
}

export function useCreateEditProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ title, source }: { title: string; source?: EditProjectSource }) =>
      EditProjectService.create(title, source),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      queryClient.setQueryData(["editProject", project.id], project);
    },
  });
}

export function useRenameEditProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => EditProjectService.rename(id, title),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      queryClient.setQueryData(["editProject", project.id], project);
    },
  });
}

export function useUpdateEditProjectCamera() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, camera }: { id: string; camera: CameraEditSettings }) =>
      EditProjectService.updateCamera(id, camera),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      queryClient.setQueryData(["editProject", project.id], project);
    },
  });
}

export function useUpdateEditProjectCursor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cursor }: { id: string; cursor: CursorEditSettings }) =>
      EditProjectService.updateCursor(id, cursor),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      queryClient.setQueryData(["editProject", project.id], project);
    },
  });
}

export function useUpdateEditProjectBackground() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, background }: { id: string; background: BackgroundEditSettings }) =>
      EditProjectService.updateBackground(id, background),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      queryClient.setQueryData(["editProject", project.id], project);
    },
  });
}

export function useUpdateEditProjectSound() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, sound }: { id: string; sound: SoundEditSettings }) =>
      EditProjectService.updateSound(id, sound),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      queryClient.setQueryData(["editProject", project.id], project);
    },
  });
}

export function useUpdateEditProjectLayout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, layout }: { id: string; layout: LayoutEditSettings }) =>
      EditProjectService.updateLayout(id, layout),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      queryClient.setQueryData(["editProject", project.id], project);
    },
  });
}

export function useUpdateEditProjectTimeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, timeline }: { id: string; timeline: TimelineEditSettings }) =>
      EditProjectService.updateTimeline(id, timeline),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      queryClient.setQueryData(["editProject", project.id], project);
    },
  });
}

export function useDeleteEditProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, deleteSourceFiles }: { id: string; deleteSourceFiles?: boolean }) =>
      EditProjectService.delete(id, deleteSourceFiles),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      // Otherwise the Edit page for this project (if open, or navigated back to via
      // history, e.g. clicking the Edit tab resuming its last-opened project) keeps
      // showing its last-cached title/media instead of noticing it's gone.
      queryClient.removeQueries({ queryKey: ["editProject", id] });
      queryClient.removeQueries({ queryKey: ["editProjectMedia", id] });
      // Deleting source files may have removed a library video too.
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    },
  });
}

export function useDeleteEditProjects() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, deleteSourceFiles }: { ids: string[]; deleteSourceFiles?: boolean }) =>
      EditProjectService.deleteMany(ids, deleteSourceFiles),
    // `onSettled`, not `onSuccess` — the backend still deletes every project it can even
    // when one of them fails (a locked file, etc.), then throws for the batch as a whole
    // (see deleteEditProjects's own comment). Refetching only on success would leave every
    // project that *did* get deleted still showing in a now-stale list.
    onSettled: (_data, _error, { ids }) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      for (const id of ids) {
        queryClient.removeQueries({ queryKey: ["editProject", id] });
        queryClient.removeQueries({ queryKey: ["editProjectMedia", id] });
      }
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    },
  });
}
