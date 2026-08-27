import type { NavigateFunction } from "react-router-dom";
import type { useToast } from "../hooks/useToast";
import type { StoragePreference } from "@shared/types/storage";
import type { AuthSession } from "@shared/types/auth";

/** Whether "instant share"/auto-share can actually go through right now. Both storage
 *  providers need something the user hasn't necessarily done yet: s3 needs its config
 *  filled in, and "doculigent" (the default preference — see settingsStore.ts's
 *  DEFAULT_STORAGE_PREFERENCE — so this is the common case on a fresh install/machine,
 *  not an edge case) needs an active doculigent.com sign-in, since DoculigentTeamShare
 *  (SharePage.tsx) can't upload without a session. Checking only the s3 case here used to
 *  let the default "doculigent, but signed out" state slip through as "set up", which sent
 *  Quick Recording's auto-share (RecordingSaveToast.tsx) straight into SharePage instead of
 *  showing this toast — landing on a bare "sign in to share" notice with no explanation and
 *  only one of the two toasts (no storage-setup one) after a recording finished. */
export function isStorageNotSetUp(
  preference: StoragePreference | undefined,
  session: AuthSession | null,
  authReady: boolean
): boolean {
  if (!preference) return true;
  if (preference.provider === "s3") return !preference.s3;
  if (preference.provider === "google_drive") return !preference.googleDrive;
  // Auth hasn't resolved yet — treat as "not set up" rather than risk a false "it's ready"
  // read that sends auto-share into SharePage before we actually know if there's a session.
  if (!authReady) return true;
  return !session;
}

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
