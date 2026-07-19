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

export function useDeleteVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => LibraryService.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["videos"] }),
  });
}

export function useTrimVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, startSecs, endSecs }: { id: string; startSecs: number; endSecs: number }) =>
      LibraryService.trim(id, startSecs, endSecs),
    onSuccess: (video) => {
      queryClient.invalidateQueries({ queryKey: ["videos"] });
      queryClient.setQueryData(["video", video.id], video);
    },
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
