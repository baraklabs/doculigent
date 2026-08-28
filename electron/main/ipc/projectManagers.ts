import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { ProjectManager } from "@shared/types/projectManager";
import * as store from "../native/settingsStore";
import { generateFileInsight, generateOverallInsight } from "../projectManagers/insights";

export function registerProjectManagersIpc(): void {
  ipcMain.handle(Channels.pm.list, async (): Promise<ProjectManager[]> => store.listProjectManagers());

  ipcMain.handle(Channels.pm.save, async (_event, pm: ProjectManager): Promise<ProjectManager> => {
    const saved: ProjectManager = pm.id ? pm : { ...pm, id: randomUUID() };
    store.saveProjectManager(saved);
    return saved;
  });

  ipcMain.handle(Channels.pm.delete, async (_event, id: string): Promise<void> => store.deleteProjectManager(id));

  ipcMain.handle(
    Channels.pm.generateInsight,
    async (_event, pmId: string, fileId: string, fileName: string, profileId?: string): Promise<ProjectManager> => {
      const pm = store.getProjectManager(pmId);
      if (!pm) throw new Error("Project Manager not found.");
      const insight = await generateFileInsight(pm, fileId, fileName, profileId);
      const insights = [...pm.insights.filter((i) => i.fileId !== fileId), insight];
      const updated: ProjectManager = { ...pm, insights };
      store.saveProjectManager(updated);
      return updated;
    }
  );

  ipcMain.handle(
    Channels.pm.generateOverallInsight,
    async (_event, pmId: string, profileId?: string): Promise<ProjectManager> => {
      const pm = store.getProjectManager(pmId);
      if (!pm) throw new Error("Project Manager not found.");
      const overallInsight = await generateOverallInsight(pm, profileId);
      const updated: ProjectManager = { ...pm, overallInsight };
      store.saveProjectManager(updated);
      return updated;
    }
  );

  ipcMain.handle(Channels.pm.markAutoProcessed, async (_event, pmId: string): Promise<ProjectManager> => {
    const pm = store.getProjectManager(pmId);
    if (!pm) throw new Error("Project Manager not found.");
    const updated: ProjectManager = { ...pm, autoProcessedAt: new Date().toISOString() };
    store.saveProjectManager(updated);
    return updated;
  });
}
