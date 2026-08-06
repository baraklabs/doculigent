import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProjectManager } from "@shared/types/projectManager";
import { ProjectManagerService } from "../services/projectManagers/ProjectManagerService";

export function useProjectManagers() {
  return useQuery<ProjectManager[]>({
    queryKey: ["projectManagers"],
    queryFn: () => ProjectManagerService.list(),
  });
}

function useInvalidateProjectManagers() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["projectManagers"] });
}

export function useSaveProjectManager() {
  const invalidate = useInvalidateProjectManagers();
  return useMutation({
    mutationFn: (pm: ProjectManager) => ProjectManagerService.save(pm),
    onSuccess: invalidate,
  });
}

export function useDeleteProjectManager() {
  const invalidate = useInvalidateProjectManagers();
  return useMutation({
    mutationFn: (id: string) => ProjectManagerService.delete(id),
    onSuccess: invalidate,
  });
}

export function useGenerateInsight() {
  const invalidate = useInvalidateProjectManagers();
  return useMutation({
    mutationFn: (vars: { pmId: string; fileId: string; fileName: string; profileId?: string }) =>
      ProjectManagerService.generateInsight(vars.pmId, vars.fileId, vars.fileName, vars.profileId),
    onSuccess: invalidate,
  });
}

export function useGenerateOverallInsight() {
  const invalidate = useInvalidateProjectManagers();
  return useMutation({
    mutationFn: (vars: { pmId: string; profileId?: string }) =>
      ProjectManagerService.generateOverallInsight(vars.pmId, vars.profileId),
    onSuccess: invalidate,
  });
}

export function useMarkProjectManagerAutoProcessed() {
  const invalidate = useInvalidateProjectManagers();
  return useMutation({
    mutationFn: (pmId: string) => ProjectManagerService.markAutoProcessed(pmId),
    onSuccess: invalidate,
  });
}

export function useRunProjectManager() {
  const invalidate = useInvalidateProjectManagers();
  return useMutation({
    mutationFn: (pmId: string) => ProjectManagerService.run(pmId),
    onSuccess: invalidate,
  });
}
