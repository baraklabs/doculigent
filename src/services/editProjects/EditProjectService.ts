import type { EditProject } from "@shared/types/models";

export const EditProjectService = {
  list(): Promise<EditProject[]> {
    return window.api.editProjects.list();
  },
  get(id: string): Promise<EditProject | null> {
    return window.api.editProjects.get(id);
  },
  create(input: {
    name: string;
    sourceFilePath: string;
    sourceKind: "video" | "audio";
    sourceVideoId: string | null;
    durationSecs: number;
  }): Promise<EditProject> {
    return window.api.editProjects.create(input);
  },
  update(
    id: string,
    patch: Partial<Pick<EditProject, "name" | "sourceFilePath" | "trimStart" | "trimEnd" | "cuts">>
  ): Promise<EditProject> {
    return window.api.editProjects.update(id, patch);
  },
  delete(id: string): Promise<void> {
    return window.api.editProjects.delete(id);
  },
  pickImportFile(): Promise<string | null> {
    return window.api.editProjects.pickImportFile();
  },
  fileExists(filePath: string): Promise<boolean> {
    return window.api.editProjects.fileExists(filePath);
  },
  export(id: string, keepRanges: [number, number][]): Promise<{ outputPath: string }> {
    return window.api.editProjects.export(id, keepRanges);
  },
};
