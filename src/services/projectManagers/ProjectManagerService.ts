import type { ProjectManager } from "@shared/types/projectManager";

export const ProjectManagerService = {
  list(): Promise<ProjectManager[]> {
    return window.api.pm.list();
  },
  save(pm: ProjectManager): Promise<ProjectManager> {
    return window.api.pm.save(pm);
  },
  delete(id: string): Promise<void> {
    return window.api.pm.delete(id);
  },
  generateInsight(pmId: string, fileId: string, fileName: string, profileId?: string): Promise<ProjectManager> {
    return window.api.pm.generateInsight(pmId, fileId, fileName, profileId);
  },
  generateOverallInsight(pmId: string, profileId?: string): Promise<ProjectManager> {
    return window.api.pm.generateOverallInsight(pmId, profileId);
  },
  markAutoProcessed(pmId: string): Promise<ProjectManager> {
    return window.api.pm.markAutoProcessed(pmId);
  },
};
