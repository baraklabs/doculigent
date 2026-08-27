import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { GoogleDriveStatus } from "@shared/types/storage";
import { getGoogleDriveStatus, signInToGoogleDrive, signOutOfGoogleDrive } from "../auth/googleDriveAuth";

export function registerGoogleDriveIpc(): void {
  ipcMain.handle(Channels.googleDrive.getStatus, async (): Promise<GoogleDriveStatus> => getGoogleDriveStatus());
  ipcMain.handle(Channels.googleDrive.signIn, async (): Promise<GoogleDriveStatus> => signInToGoogleDrive());
  ipcMain.handle(Channels.googleDrive.signOut, async (): Promise<void> => signOutOfGoogleDrive());
}
