import { dialog, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Channels } from "@shared/constants/channels";
import type { CutRange, EditProject } from "@shared/types/models";
import { NotFoundError } from "@shared/ipc/errors";
import * as store from "../native/libraryStore";
import { exportEdit } from "../native/ffmpeg";
import { removeEditProjectFile, writeEditProjectFile } from "../native/editProjectFile";

interface CreateEditProjectInput {
  name: string;
  sourceFilePath: string;
  sourceKind: "video" | "audio";
  sourceVideoId: string | null;
  durationSecs: number;
}

interface UpdateEditProjectInput {
  name?: string;
  sourceFilePath?: string;
  trimStart?: number;
  trimEnd?: number;
  cuts?: CutRange[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pickExportPath(sourceFilePath: string, ext: string): Promise<string> {
  const dir = path.dirname(sourceFilePath);
  const base = path.basename(sourceFilePath, path.extname(sourceFilePath));
  let candidate = path.join(dir, `${base}-edited.${ext}`);
  let n = 2;
  while (await fileExists(candidate)) {
    candidate = path.join(dir, `${base}-edited-${n}.${ext}`);
    n += 1;
  }
  return candidate;
}

export function registerEditProjectsIpc(): void {
  ipcMain.handle(Channels.editProjects.list, async (): Promise<EditProject[]> => store.listEditProjects());

  ipcMain.handle(Channels.editProjects.get, async (_event, id: string): Promise<EditProject | null> =>
    store.getEditProject(id)
  );

  ipcMain.handle(
    Channels.editProjects.create,
    async (_event, input: CreateEditProjectInput): Promise<EditProject> => {
      const now = new Date().toISOString();
      const project: EditProject = {
        id: randomUUID(),
        name: input.name,
        sourceFilePath: input.sourceFilePath,
        sourceKind: input.sourceKind,
        sourceVideoId: input.sourceVideoId,
        durationSecs: input.durationSecs,
        trimStart: 0,
        trimEnd: input.durationSecs,
        cuts: [],
        lastExportPath: null,
        createdAt: now,
        updatedAt: now,
      };
      store.insertEditProject(project);
      await writeEditProjectFile(project);
      return project;
    }
  );

  ipcMain.handle(
    Channels.editProjects.update,
    async (_event, id: string, patch: UpdateEditProjectInput): Promise<EditProject> => {
      const before = store.getEditProject(id);
      if (!before) throw new NotFoundError(`edit project ${id}`);
      const updated = store.updateEditProject(id, patch);
      if (!updated) throw new NotFoundError(`edit project ${id}`);

      if (patch.sourceFilePath && patch.sourceFilePath !== before.sourceFilePath) {
        await removeEditProjectFile(before.sourceFilePath, id);
      }
      await writeEditProjectFile(updated);
      return updated;
    }
  );

  ipcMain.handle(Channels.editProjects.delete, async (_event, id: string): Promise<void> => {
    const existing = store.getEditProject(id);
    store.deleteEditProject(id);
    if (existing) await removeEditProjectFile(existing.sourceFilePath, id);
  });

  ipcMain.handle(Channels.editProjects.pickImportFile, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Video & Audio", extensions: ["mp4", "mov", "mkv", "webm", "avi", "wav", "mp3", "m4a", "flac", "ogg"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(Channels.editProjects.fileExists, async (_event, filePath: string): Promise<boolean> =>
    fileExists(filePath)
  );

  ipcMain.handle(
    Channels.editProjects.export,
    async (_event, id: string, keepRanges: [number, number][]): Promise<{ outputPath: string }> => {
      const project = store.getEditProject(id);
      if (!project) throw new NotFoundError(`edit project ${id}`);
      if (!(await fileExists(project.sourceFilePath))) {
        throw new Error(`Original file not found: ${project.sourceFilePath}. Relink it before exporting.`);
      }

      const hasVideo = project.sourceKind === "video";
      const outputPath = await pickExportPath(project.sourceFilePath, hasVideo ? "mp4" : "wav");
      await exportEdit(project.sourceFilePath, outputPath, keepRanges, hasVideo);
      const updated = store.updateEditProject(id, { lastExportPath: outputPath });
      if (updated) await writeEditProjectFile(updated);
      return { outputPath };
    }
  );
}
