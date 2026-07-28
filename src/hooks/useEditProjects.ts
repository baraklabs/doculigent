import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EditProject } from "@shared/types/models";
import { EditProjectService } from "../services/editProjects/EditProjectService";

export function useEditProjects() {
  return useQuery<EditProject[]>({
    queryKey: ["editProjects"],
    queryFn: () => EditProjectService.list(),
  });
}

export function useEditProject(id: string | undefined) {
  return useQuery<EditProject | null>({
    queryKey: ["editProject", id],
    queryFn: () => (id ? EditProjectService.get(id) : Promise.resolve(null)),
    enabled: !!id,
  });
}

export function useCreateEditProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      sourceFilePath: string;
      sourceKind: "video" | "audio";
      sourceVideoId: string | null;
      durationSecs: number;
    }) => EditProjectService.create(input),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      queryClient.setQueryData(["editProject", project.id], project);
    },
  });
}

export function useUpdateEditProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<Pick<EditProject, "name" | "sourceFilePath" | "trimStart" | "trimEnd" | "cuts">>;
    }) => EditProjectService.update(id, patch),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["editProjects"] });
      queryClient.setQueryData(["editProject", project.id], project);
    },
  });
}

export function useDeleteEditProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => EditProjectService.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["editProjects"] }),
  });
}

export function useExportEditProject() {
  return useMutation({
    mutationFn: ({ id, keepRanges }: { id: string; keepRanges: [number, number][] }) =>
      EditProjectService.export(id, keepRanges),
  });
}
