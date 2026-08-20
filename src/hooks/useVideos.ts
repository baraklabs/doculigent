import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Transcript, Video } from "@shared/types/models";
import { LibraryService } from "../services/library/LibraryService";
import { SearchService } from "../services/search/SearchService";

export function useVideos(query: string) {
  return useQuery<Video[]>({
    queryKey: ["videos", query],
    queryFn: () => (query.trim() ? SearchService.search(query) : LibraryService.list()),
  });
}

export function useVideo(id: string | undefined) {
  return useQuery<Video | null>({
    queryKey: ["video", id],
    queryFn: () => (id ? LibraryService.get(id) : Promise.resolve(null)),
    enabled: !!id,
  });
}

/** Waits a couple of paint cycles so a just-unmounted <video> (see LibraryPage's video
 *  cards, which keep `src` pointed at the file the whole time it's in the list, not just
 *  on hover) has actually released its underlying file handle before the main process
 *  tries to unlink it — otherwise the delete fails with EBUSY on Windows, which (unlike
 *  POSIX) refuses to remove a file still held open by the app itself. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

export function useDeleteVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, keepFile }: { id: string; keepFile?: boolean }) => {
      queryClient.setQueriesData<Video[]>({ queryKey: ["videos"] }, (old) => old?.filter((v) => v.id !== id));
      await nextPaint();
      return LibraryService.delete(id, keepFile);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["videos"] }),
  });
}

export function useDeleteVideos() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, keepFile }: { ids: string[]; keepFile?: boolean }) => {
      const idSet = new Set(ids);
      queryClient.setQueriesData<Video[]>({ queryKey: ["videos"] }, (old) => old?.filter((v) => !idSet.has(v.id)));
      await nextPaint();
      return LibraryService.deleteMany(ids, keepFile);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["videos"] }),
  });
}

export function useRenameVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => LibraryService.rename(id, title),
    onSuccess: (video) => {
      queryClient.invalidateQueries({ queryKey: ["videos"] });
      queryClient.setQueryData(["video", video.id], video);
    },
  });
}

export function useImportVideos() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ filePaths, kind }: { filePaths: string[]; kind: "video" | "audio" }) =>
      LibraryService.importFiles(filePaths, kind),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["videos"] }),
  });
}

export function useSetVideoTranscript() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, transcript }: { id: string; transcript: Transcript | null }) =>
      LibraryService.setTranscript(id, transcript),
    onSuccess: (video) => {
      queryClient.invalidateQueries({ queryKey: ["videos"] });
      queryClient.setQueryData(["video", video.id], video);
    },
  });
}
