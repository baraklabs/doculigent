/**
 * Where downloaded Whisper model files live, and how Settings > Transcription inspects/
 * clears them. Deliberately NOT @huggingface/transformers' default cache location (a
 * `.cache` folder next to the package inside node_modules) — that path ends up inside
 * `app.asar` once packaged, which is read-only, so downloads would silently fail in
 * production. This points at the app's userData dir instead (same place
 * settings.json/database.sqlite live), which is always writable. whisper.ts sets
 * `env.cacheDir` to this on startup.
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { WHISPER_MODELS, whisperModelHfId, whisperModelHfIdEn, whisperModelHasEnglishVariant } from "@shared/constants/whisperModels";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";

export function whisperCacheDir(): string {
  return path.join(app.getPath("userData"), "whisper-models");
}

// @huggingface/transformers lays cached files out as <cacheDir>/<hfModelId>/... — a "size"
// here maps to up to two such folders (multilingual + English-only, see whisper.ts's
// runWhisperOnSamples for when each is used — large-v3/turbo only ever have the
// multilingual one), so status/delete below treat both as one unit from the user's point
// of view.
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
    return 0; // not downloaded (or not yet created)
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
