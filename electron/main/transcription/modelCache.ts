
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { WHISPER_MODELS, whisperModelHfId, whisperModelHfIdEn, whisperModelHasEnglishVariant } from "@shared/constants/whisperModels";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";

export function whisperCacheDir(): string {
  return path.join(app.getPath("userData"), "whisper-models");
}

function modelDirs(size: WhisperModelSize): string[] {
  const dirs = [path.join(whisperCacheDir(), whisperModelHfId(size))];
  if (whisperModelHasEnglishVariant(size)) dirs.push(path.join(whisperCacheDir(), whisperModelHfIdEn(size)));
  return dirs;
}

function dirSizeBytes(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; 
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : fs.statSync(full).size;
  }
  return total;
}

export function getWhisperModelStatuses(): WhisperModelStatus[] {
  return WHISPER_MODELS.map((m) => {
    const sizeBytes = modelDirs(m.size).reduce((sum, dir) => sum + dirSizeBytes(dir), 0);
    return { size: m.size, downloaded: sizeBytes > 0, sizeBytes };
  });
}

export function deleteWhisperModelCache(size: WhisperModelSize): void {
  for (const dir of modelDirs(size)) fs.rmSync(dir, { recursive: true, force: true });
}
