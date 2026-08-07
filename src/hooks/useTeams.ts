import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeamFileStatus } from "@shared/types/team";
import { TeamsService } from "../services/teams/TeamsService";

export function teamErrorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
}

export function teamErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function teamErrorStatus(err: unknown): number | undefined {
  return err && typeof err === "object" && "status" in err ? (err as { status?: number }).status : undefined;
}

export function useTeams(enabled = true) {
  return useQuery({
    queryKey: ["teams"],
    queryFn: () => TeamsService.list(),
    enabled,
  });
}

export function useTeam(teamId: string | null) {
  return useQuery({
    queryKey: ["team", teamId],
    queryFn: () => TeamsService.get(teamId!),
    enabled: !!teamId,
  });
}

export function useTeamFiles(teamId: string, status: TeamFileStatus, enabled = true) {
  return useQuery({
    queryKey: ["teamFiles", teamId, status],
    queryFn: () => TeamsService.listFiles(teamId, status),
    enabled,
  });
}

export function useSyncedTeamFileIds() {
  return useQuery({
    queryKey: ["teamSyncedFileIds"],
    queryFn: () => TeamsService.listSyncedFileIds(),
  });
}

function useInvalidateTeams() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["teams"] });
}

function useInvalidateTeam(teamId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["team", teamId] });
    queryClient.invalidateQueries({ queryKey: ["teamFiles", teamId] });
    queryClient.invalidateQueries({ queryKey: ["teams"] });
  };
}

export function useCreateTeam() {
  const invalidate = useInvalidateTeams();
  return useMutation({
    mutationFn: (name: string) => TeamsService.create(name),
    onSuccess: invalidate,
  });
}

export function useDeleteTeam() {
  const invalidate = useInvalidateTeams();
  return useMutation({
    mutationFn: (teamId: string) => TeamsService.delete(teamId),
    onSuccess: invalidate,
  });
}

export function useInviteMember(teamId: string) {
  const invalidate = useInvalidateTeam(teamId);
  return useMutation({
    mutationFn: (email: string) => TeamsService.inviteMember(teamId, email),
    onSuccess: invalidate,
  });
}

export function useRemoveMember(teamId: string) {
  const invalidate = useInvalidateTeam(teamId);
  return useMutation({
    mutationFn: (memberId: string) => TeamsService.removeMember(teamId, memberId),
    onSuccess: invalidate,
  });
}

export function useUploadTeamFile(teamId: string) {
  const invalidate = useInvalidateTeam(teamId);
  return useMutation({
    mutationFn: ({ filePath, displayName }: { filePath: string; displayName?: string }) => {
      const uploadId = crypto.randomUUID();
      return TeamsService.uploadFile(uploadId, teamId, filePath, displayName);
    },
    onSuccess: invalidate,
  });
}

export function useDeleteTeamFile(teamId: string) {
  const invalidate = useInvalidateTeam(teamId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ fileId, alreadyTrashed }: { fileId: string; alreadyTrashed?: boolean }) => {
      if (!alreadyTrashed) await TeamsService.setFileStatus(fileId, "trash");
      await TeamsService.permanentlyDeleteFile(fileId);
    },
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["teamSyncedFileIds"] });
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    },
  });
}
