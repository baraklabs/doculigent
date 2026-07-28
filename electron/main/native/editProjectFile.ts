
import fs from "node:fs/promises";
import path from "node:path";
import type { EditProject } from "@shared/types/models";

export function editProjectFilePath(sourceFilePath: string, projectId: string): string {
  const dir = path.dirname(sourceFilePath);
  const base = path.basename(sourceFilePath, path.extname(sourceFilePath));
  return path.join(dir, `${base}.edit-${projectId.slice(0, 8)}.json`);
}

export async function writeEditProjectFile(project: EditProject): Promise<void> {
  try {
    await fs.writeFile(editProjectFilePath(project.sourceFilePath, project.id), JSON.stringify(project, null, 2), "utf-8");
  } catch (e) {
    console.error("Couldn't write edit project sidecar file:", e);
  }
}

export async function removeEditProjectFile(sourceFilePath: string, projectId: string): Promise<void> {
  try {
    await fs.rm(editProjectFilePath(sourceFilePath, projectId), { force: true });
  } catch (e) {
    console.error("Couldn't remove edit project sidecar file:", e);
  }
}
