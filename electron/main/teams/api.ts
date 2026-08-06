
import { FUNCTIONS_BASE_URL } from "@shared/constants/authConfig";
import type { Team, TeamFile, TeamFileStatus, TeamMember, FileUploadTicket, FileDownloadTicket } from "@shared/types/team";
import { authorizedFetch } from "../auth/apiClient";

export class TeamApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "TeamApiError";
  }
}

interface EdgeErrorBody {
  error?: string;
  code?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authorizedFetch(`${FUNCTIONS_BASE_URL}/${path}`, init);
  if (!res.ok) {
    let body: EdgeErrorBody = {};
    try {
      body = (await res.json()) as EdgeErrorBody;
    } catch {
      // Non-JSON error body — fall back to the generic message below.
    }
    throw new TeamApiError(body.error ?? `Request failed (${res.status})`, body.code, res.status);
  }
  return (await res.json()) as T;
}

function postJson<T>(name: string, body: unknown): Promise<T> {
  return call<T>(name, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getWithQuery<T>(name: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  return call<T>(qs ? `${name}?${qs}` : name);
}

export function createTeam(name: string): Promise<Team> {
  return postJson<{ team: Team }>("team-create", { name }).then((r) => r.team);
}

export function listTeams(): Promise<Team[]> {
  return call<{ teams: Team[] }>("team-list").then((r) => r.teams);
}

export function getTeam(teamId: string): Promise<{ team: Team; members: TeamMember[]; files: TeamFile[] }> {
  return getWithQuery("team-get", { teamId });
}

export function inviteMember(teamId: string, email: string): Promise<TeamMember> {
  return postJson<{ member: TeamMember }>("team-invite", { teamId, email }).then((r) => r.member);
}

export function removeMember(teamId: string, memberId: string): Promise<void> {
  return postJson<{ ok: true }>("team-member-remove", { teamId, memberId }).then(() => undefined);
}

export function deleteTeam(teamId: string): Promise<void> {
  return postJson<{ ok: true }>("team-delete", { teamId }).then(() => undefined);
}

export function presignUpload(
  teamId: string,
  fileName: string,
  mimeType: string,
  sizeBytes: number
): Promise<FileUploadTicket> {
  return postJson<FileUploadTicket>("file-presign-upload", { teamId, fileName, mimeType, sizeBytes });
}

export function confirmUpload(
  teamId: string,
  fileId: string,
  storagePath: string,
  name: string,
  mimeType: string
): Promise<TeamFile> {
  return postJson<{ file: TeamFile }>("file-confirm-upload", { teamId, fileId, storagePath, name, mimeType }).then(
    (r) => r.file
  );
}

export function listFiles(teamId: string, status: TeamFileStatus = "active"): Promise<TeamFile[]> {
  return getWithQuery<{ files: TeamFile[] }>("file-list", { teamId, status }).then((r) => r.files);
}

export function presignDownload(fileId: string): Promise<FileDownloadTicket> {
  return getWithQuery("file-presign-download", { fileId });
}

export function setFileStatus(fileId: string, status: TeamFileStatus): Promise<TeamFile> {
  return postJson<{ file: TeamFile }>("file-update-status", { fileId, status }).then((r) => r.file);
}

export function permanentlyDeleteFile(fileId: string): Promise<void> {
  return postJson<{ ok: true }>("file-update-status", { fileId, permanentlyDelete: true }).then(() => undefined);
}
