import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      // Keep fetched data in memory for a long while so tabs repaint instantly from cache
      // (and quietly refresh in the background) instead of showing a loading state.
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});
