import { getStoragePreference } from "../native/settingsStore";
import { createDoculigentProvider } from "./doculigentProvider";
import { createS3Provider } from "./s3Provider";
import { createGoogleDriveProvider } from "./googleDriveProvider";
import type { StorageProvider } from "./StorageProvider";

export type { StorageProvider } from "./StorageProvider";

export async function getActiveProvider(teamId?: string): Promise<StorageProvider> {
  const preference = getStoragePreference();

  if (preference.provider === "s3") {
    if (!preference.s3) throw new Error("S3 isn't configured yet — set it up in Settings > Storage.");
    return createS3Provider(preference.s3, teamId);
  }

  if (preference.provider === "google_drive") {
    if (!preference.googleDrive) throw new Error("Google Drive isn't configured yet — set it up in Settings > Storage.");
    return createGoogleDriveProvider(preference.googleDrive);
  }

  if (!teamId) throw new Error("A team must be selected when using Doculigent Cloud storage.");
  return createDoculigentProvider(teamId);
}
