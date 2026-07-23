import { ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { AuthSession } from "@shared/types/auth";
import * as doculigentAuth from "../auth/doculigentAuth";

export function registerAuthIpc(): void {
  ipcMain.handle(Channels.auth.getSession, async (): Promise<AuthSession | null> => doculigentAuth.getSession());

  ipcMain.handle(Channels.auth.login, async (): Promise<AuthSession> => doculigentAuth.login());

  ipcMain.handle(Channels.auth.submitManualCode, async (_event, code: string): Promise<void> => {
    doculigentAuth.submitManualCode(code);
  });

  ipcMain.handle(Channels.auth.cancelLogin, async (): Promise<void> => doculigentAuth.cancelLogin());

  ipcMain.handle(Channels.auth.logout, async (): Promise<void> => doculigentAuth.logout());
}
