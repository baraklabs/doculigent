import type { FileDownloadTicket, Team, TeamFile, TeamFileStatus, TeamMember } from "@shared/types/team";
import type { Video } from "@shared/types/models";

export const TeamsService = {
  create(name: string): Promise<Team> {
    return window.api.teams.create(name);
  },
  list(): Promise<Team[]> {
    return window.api.teams.list();
  },
  get(teamId: string): Promise<{ team: Team; members: TeamMember[]; files: TeamFile[] }> {
    return window.api.teams.get(teamId);
  },
  inviteMember(teamId: string, email: string): Promise<TeamMember> {
    return window.api.teams.inviteMember(teamId, email);
  },
  removeMember(teamId: string, memberId: string): Promise<void> {
    return window.api.teams.removeMember(teamId, memberId);
  },
  delete(teamId: string): Promise<void> {
    return window.api.teams.delete(teamId);
  },
  listFiles(teamId: string, status?: TeamFileStatus): Promise<TeamFile[]> {
    return window.api.teams.listFiles(teamId, status);
  },
  presignDownload(fileId: string): Promise<FileDownloadTicket> {
    return window.api.teams.presignDownload(fileId);
  },
  setFileStatus(fileId: string, status: TeamFileStatus): Promise<TeamFile> {
    return window.api.teams.setFileStatus(fileId, status);
  },
  permanentlyDeleteFile(fileId: string): Promise<void> {
    return window.api.teams.permanentlyDeleteFile(fileId);
  },
  uploadFile(uploadId: string, teamId: string, filePath: string, displayName?: string): Promise<TeamFile> {
    return window.api.teams.uploadFile(uploadId, teamId, filePath, displayName);
  },
  onUploadProgress(callback: (progress: { uploadId: string; percent: number }) => void): () => void {
    return window.api.teams.onUploadProgress(callback);
  },
  downloadToLibrary(teamId: string, fileId: string): Promise<Video> {
    return window.api.teams.downloadToLibrary(teamId, fileId);
  },
  listSyncedFileIds(): Promise<string[]> {
    return window.api.teams.listSyncedFileIds();
  },
};
