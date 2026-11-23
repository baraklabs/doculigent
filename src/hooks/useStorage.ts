import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StoragePreference } from "@shared/types/storage";
import { StorageService } from "../services/storage/StorageService";
import { registerUploadCancel, useUploadStore } from "../store/uploadStore";
import { isUploadCancelled } from "../lib/uploadCancel";

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

export function useTestStoragePreference() {
  return useMutation({
    mutationFn: ({ preference, s3SecretKey }: { preference: StoragePreference; s3SecretKey?: string | null }) =>
      StorageService.testConnection(preference, s3SecretKey),
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
  // Set for a file that's part of a batch: the batch owns the popup/tray card, so this file
  // doesn't get its own, and reports its progress through onProgress instead.
  const silentRef = useRef(false);
  const onProgressRef = useRef<((percent: number) => void) | undefined>(undefined);

  useEffect(
    () =>
      StorageService.onUploadProgress(({ uploadId, percent }) => {
        if (uploadId !== activeUploadId.current) return;
        setUploadPercent(percent);
        onProgressRef.current?.(percent);
      }),
    []
  );

  const mutation = useMutation({
    mutationFn: ({
      filePath,
      displayName,
      silent,
      onProgress,
    }: {
      filePath: string;
      displayName?: string;
      /** Part of a batch — skip this file's own popup/tray card (the batch has one). */
      silent?: boolean;
      onProgress?: (percent: number) => void;
    }) => {
      const uploadId = crypto.randomUUID();
      activeUploadId.current = uploadId;
      silentRef.current = !!silent;
      onProgressRef.current = onProgress;
      setUploadPercent(0);
      // Tracked app-wide so the popup / bottom-right tray survive switching tabs.
      if (!silent) {
        useUploadStore.getState().start(uploadId, displayName ?? filePath.split(/[\\/]/).pop() ?? filePath);
        registerUploadCancel(uploadId, () => void StorageService.cancelUpload(uploadId));
      }
      return StorageService.uploadFile(uploadId, teamId, filePath, displayName);
    },
    onSuccess: () => {
      if (activeUploadId.current && !silentRef.current) useUploadStore.getState().finish(activeUploadId.current);
      return queryClient.invalidateQueries({ queryKey: ["storageFiles", teamId] });
    },
    onError: (err) => {
      if (activeUploadId.current && !silentRef.current && isUploadCancelled(err)) {
        useUploadStore.getState().dismiss(activeUploadId.current); // a cancel isn't a failure
      } else if (activeUploadId.current && !silentRef.current) {
        useUploadStore.getState().finish(activeUploadId.current, err instanceof Error ? err.message : String(err));
      }
    },
    onSettled: () => {
      activeUploadId.current = null;
      onProgressRef.current = undefined;
      setUploadPercent(null);
    },
  });

  /** Cancels whichever upload this hook is running right now (used by batch uploads). */
  function cancelActive() {
    if (activeUploadId.current) void StorageService.cancelUpload(activeUploadId.current);
  }

  return { ...mutation, uploadPercent, cancelActive };
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
