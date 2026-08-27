import type { GoogleDriveStatus } from "@shared/types/storage";

export const GoogleDriveService = {
  getStatus(): Promise<GoogleDriveStatus> {
    return window.api.googleDrive.getStatus();
  },
  signIn(): Promise<GoogleDriveStatus> {
    return window.api.googleDrive.signIn();
  },
  signOut(): Promise<void> {
    return window.api.googleDrive.signOut();
  },
  onStatusChanged(callback: (status: GoogleDriveStatus) => void): () => void {
    return window.api.googleDrive.onStatusChanged(callback);
  },
};
