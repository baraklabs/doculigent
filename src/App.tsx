import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { queryClient } from "./lib/queryClient";
import { router } from "./app/router";

export function App() {
  // Swallows any file drag that doesn't land on one of the app's own drop targets (the Edit
  // page's Video/Audio timeline tracks, the storage/team upload zones). Without this,
  // Chromium's default action for a dropped file is to *navigate* the window to it —
  // replacing the whole app with a raw video player, with no way back short of a restart.
  // Bubble phase, so a real drop target's own handler still runs first (and has already
  // called preventDefault itself); this only catches the ones that reach the document
  // unhandled. dragover needs the same treatment: a drop event only fires at all where
  // dragover was prevented, so preventing it here is what makes the miss land on this
  // handler rather than on the browser's default.
  useEffect(() => {
    function swallow(e: DragEvent) {
      e.preventDefault();
    }
    document.addEventListener("dragover", swallow);
    document.addEventListener("drop", swallow);
    return () => {
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
