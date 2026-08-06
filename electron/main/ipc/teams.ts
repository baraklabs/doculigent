import fs from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import { Channels } from "@shared/constants/channels";
import type { Team, TeamFile, TeamFileStatus, TeamMember } from "@shared/types/team";
import type { Video } from "@shared/types/models";
import * as teamApi from "../teams/api";
import { uploadTeamFile } from "../teams/upload";
import { syncTeamFileToLibrary } from "../teams/sync";
import * as libraryStore from "../native/libraryStore";

function broadcastUploadProgress(uploadId: string, percent: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(Channels.teams.uploadProgress, { uploadId, percent });
  }
}

export function registerTeamsIpc(): void {
  ipcMain.handle(Channels.teams.create, async (_event, name: string): Promise<Team> => teamApi.createTeam(name));

  ipcMain.handle(Channels.teams.list, async (): Promise<Team[]> => teamApi.listTeams());

  ipcMain.handle(
    Channels.teams.get,
    async (_event, teamId: string): Promise<{ team: Team; members: TeamMember[]; files: TeamFile[] }> =>
      teamApi.getTeam(teamId)
  );

  ipcMain.handle(
    Channels.teams.inviteMember,
    async (_event, teamId: string, email: string): Promise<TeamMember> => teamApi.inviteMember(teamId, email)
  );

  ipcMain.handle(
    Channels.teams.removeMember,
    async (_event, teamId: string, memberId: string): Promise<void> => teamApi.removeMember(teamId, memberId)
  );

  ipcMain.handle(Channels.teams.delete, async (_event, teamId: string): Promise<void> => teamApi.deleteTeam(teamId));

  ipcMain.handle(
    Channels.teams.listFiles,
    async (_event, teamId: string, status?: TeamFileStatus): Promise<TeamFile[]> => teamApi.listFiles(teamId, status)
  );

  ipcMain.handle(
    Channels.teams.presignDownload,
    async (_event, fileId: string) => teamApi.presignDownload(fileId)
  );

  ipcMain.handle(
    Channels.teams.setFileStatus,
    async (_event, fileId: string, status: TeamFileStatus): Promise<TeamFile> => teamApi.setFileStatus(fileId, status)
  );

  ipcMain.handle(Channels.teams.permanentlyDeleteFile, async (_event, fileId: string): Promise<void> => {
    await teamApi.permanentlyDeleteFile(fileId);
    const localVideo = libraryStore.getVideoBySyncedTeamFileId(fileId);
    if (localVideo) {
      libraryStore.deleteVideo(localVideo.id);
      await fs.rm(path.dirname(localVideo.filePath), { recursive: true, force: true });
    }
  });

  ipcMain.handle(
    Channels.teams.uploadFile,
    async (_event, uploadId: string, teamId: string, filePath: string, displayName?: string): Promise<TeamFile> =>
      uploadTeamFile(teamId, filePath, displayName, (percent) => broadcastUploadProgress(uploadId, percent))
  );

  ipcMain.handle(
    Channels.teams.downloadToLibrary,
    async (_event, teamId: string, fileId: string): Promise<Video> => syncTeamFileToLibrary(teamId, fileId)
  );

  ipcMain.handle(
    Channels.teams.listSyncedFileIds,
    async (): Promise<string[]> => libraryStore.listSyncedTeamFileIds()
  );
}
