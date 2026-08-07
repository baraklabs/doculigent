import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StoragePreference } from "@shared/types/storage";
import { StorageService } from "../services/storage/StorageService";

export function useStoragePreference() {
  return useQuery({
    queryKey: ["storagePreference"],
    queryFn: () => StorageService.getPreference(),
  });
}

export function useSetStoragePreference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ preference, s3SecretKey }: { preference: StoragePreference; s3SecretKey?: string | null }) =>
      StorageService.setPreference(preference, s3SecretKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storagePreference"] });
      queryClient.invalidateQueries({ queryKey: ["storageTeams"] });
      queryClient.invalidateQueries({ queryKey: ["storageFiles"] });
    },
  });
}

export function useStorageTeams(enabled = true) {
  return useQuery({
    queryKey: ["storageTeams"],
    queryFn: () => StorageService.listTeams(),
    enabled,
  });
}

export function useCreateStorageTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => StorageService.createTeam(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["storageTeams"] }),
  });
}

export function useDeleteStorageTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (teamId: string) => StorageService.deleteTeam(teamId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storageTeams"] });
      queryClient.invalidateQueries({ queryKey: ["teamSyncedFileIds"] });
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    },
  });
}

export function useStorageFiles(teamId: string, enabled = true) {
  return useQuery({
    queryKey: ["storageFiles", teamId],
    queryFn: () => StorageService.listFiles(teamId),
    enabled,
  });
}

export function useUploadStorageFile(teamId = "") {
  const queryClient = useQueryClient();
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const activeUploadId = useRef<string | null>(null);

  useEffect(
    () =>
      StorageService.onUploadProgress(({ uploadId, percent }) => {
        if (uploadId === activeUploadId.current) setUploadPercent(percent);
      }),
    []
  );

  const mutation = useMutation({
    mutationFn: ({ filePath, displayName }: { filePath: string; displayName?: string }) => {
      const uploadId = crypto.randomUUID();
      activeUploadId.current = uploadId;
      setUploadPercent(0);
      return StorageService.uploadFile(uploadId, teamId, filePath, displayName);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["storageFiles", teamId] }),
    onSettled: () => {
      activeUploadId.current = null;
      setUploadPercent(null);
    },
  });

  return { ...mutation, uploadPercent };
}

export function useDownloadStorageFileToLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => StorageService.downloadToLibrary(fileId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["videos"] }),
  });
}

export function useDeleteStorageFile(teamId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => StorageService.deleteFile(fileId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["storageFiles", teamId] }),
  });
}

export function useCachedShareLink(fileId: string, enabled = true) {
  return useQuery({
    queryKey: ["shareLink", fileId],
    queryFn: () => StorageService.getCachedShareLink(fileId),
    enabled,
  });
}

export function useGenerateShareLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => StorageService.getShareableLink(fileId),
    onSuccess: (link, fileId) => queryClient.setQueryData(["shareLink", fileId], link),
  });
}
