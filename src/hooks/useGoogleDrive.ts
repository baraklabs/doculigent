import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GoogleDriveService } from "../services/googleDrive/GoogleDriveService";

const GOOGLE_DRIVE_STATUS_KEY = ["googleDriveStatus"];

export function useGoogleDriveStatus() {
  const queryClient = useQueryClient();
  useEffect(
    () =>
      GoogleDriveService.onStatusChanged((status) => queryClient.setQueryData(GOOGLE_DRIVE_STATUS_KEY, status)),
    [queryClient]
  );

  return useQuery({
    queryKey: GOOGLE_DRIVE_STATUS_KEY,
    queryFn: () => GoogleDriveService.getStatus(),
  });
}

export function useGoogleDriveSignIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => GoogleDriveService.signIn(),
    onSuccess: (status) => queryClient.setQueryData(GOOGLE_DRIVE_STATUS_KEY, status),
  });
}

export function useGoogleDriveSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => GoogleDriveService.signOut(),
    onSuccess: () => queryClient.setQueryData(GOOGLE_DRIVE_STATUS_KEY, { connected: false, email: null }),
  });
}
