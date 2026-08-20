import type { NavigateFunction } from "react-router-dom";
import type { useToast } from "../hooks/useToast";

/** Shared "storage isn't set up yet" warning — used both by RecordPage's Quick/Advanced
 *  pill (switching into Quick with storage unconfigured) and by RecordingSaveToast (a
 *  Quick recording finishing with storage still unconfigured), so the message and the
 *  deep link into Settings > Storage (pre-selecting Doculigent Cloud, the no-setup-needed
 *  option) stay in one place instead of drifting apart. */
export function showStorageSetupToast(toast: ReturnType<typeof useToast>, navigate: NavigateFunction): void {
  toast.warning("Setup Storage to enable instant sharing.", {
    title: "Set up storage",
    action: {
      label: "Go to Settings > Storage",
      onClick: () => navigate("/settings?section=storage&provider=doculigent"),
    },
  });
}
