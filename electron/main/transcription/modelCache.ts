
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
    try {
      total += entry.isDirectory() ? dirSizeBytes(full) : fs.statSync(full).size;
    } catch {
      // A file this readdir just listed can vanish (or be mid-rename) by the time we
      // stat it — most commonly @huggingface/transformers' own `*.tmp.<pid>.<rand>`
      // partial-download artifact getting renamed to its final name the instant a
      // download completes. Skip it rather than letting a stat race crash the whole
      // status computation (this is only ever a size-accounting approximation anyway).
    }
  }
  return total;
}

// In-memory only (not derived from disk) — tracks which sizes whisper.ts's preload queue
// currently has queued or actively loading, so getWhisperModelStatuses can report
// "downloading" even from a Settings page instance that didn't itself click Download (see
// whisper.ts's markDownloading / preloadWhisperModel).
const downloadingSizes = new Set<WhisperModelSize>();

export function markDownloading(size: WhisperModelSize, downloading: boolean): void {
  if (downloading) downloadingSizes.add(size);
  else downloadingSizes.delete(size);
}

export function getWhisperModelStatuses(): WhisperModelStatus[] {
  return WHISPER_MODELS.map((m) => {
    const sizeBytes = modelDirs(m.size).reduce((sum, dir) => sum + dirSizeBytes(dir), 0);
    return { size: m.size, downloaded: sizeBytes > 0, sizeBytes, downloading: downloadingSizes.has(m.size) };
  });
}

export function deleteWhisperModelCache(size: WhisperModelSize): void {
  for (const dir of modelDirs(size)) fs.rmSync(dir, { recursive: true, force: true });
}
