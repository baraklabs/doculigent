export type StorageProviderKind = "doculigent" | "s3" | "google_drive";

export interface StorageFile {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string | null;
  createdAt: string;
}

export interface StorageTeam {
  id: string;
  name: string;
}

export interface ShareLink {
  url: string;
  expiresAt: string;
}

export interface S3Config {
  accessKeyId: string;
  region: string;
  bucket: string;
  folder: string;
  endpoint?: string;
}

export interface GoogleDriveConfig {
  folder: string;
}

export interface StoragePreference {
  provider: StorageProviderKind;
  s3?: S3Config;
  googleDrive?: GoogleDriveConfig;
}

export interface GoogleDriveStatus {
  connected: boolean;
  email: string | null;
}
