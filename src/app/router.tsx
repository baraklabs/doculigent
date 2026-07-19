import { createHashRouter, Navigate } from "react-router-dom";
import { Layout } from "./layout/Layout";
import { RecordPage } from "../pages/RecordPage";
import { MeetingPage } from "../pages/MeetingPage";
import { LibraryPage } from "../pages/LibraryPage";
import { EditPage } from "../pages/EditPage";
import { AiPage } from "../pages/AiPage";
import { AiAssistantPage } from "../pages/AiAssistantPage";
import { SharePage } from "../pages/SharePage";
import { SettingsPage } from "../pages/SettingsPage";
import { AccountPage } from "../pages/AccountPage";
import { AnnotationDrawPage } from "../pages/AnnotationDrawPage";

// Hash routing (not createBrowserRouter) — the standard safe choice for an Electron app
// loading a local file:// renderer in production, where path-based history has no server
// to resolve nested routes against.
export const router = createHashRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/record" replace /> },
      { path: "record", element: <RecordPage /> },
      { path: "meeting", element: <MeetingPage /> },
      { path: "library", element: <LibraryPage /> },
      { path: "library/:id/edit", element: <EditPage /> },
      { path: "library/:id/ai", element: <AiPage /> },
      { path: "ai", element: <AiAssistantPage /> },
      { path: "library/:id/share", element: <SharePage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "account", element: <AccountPage /> },
    ],
  },
  // The "Draw on screen" overlay's draw window (electron/main/annotationWindow.ts) loads
  // this route directly, standalone — no <Layout> topbar/footer chrome, since it's a
  // transparent always-on-top window, not part of the main app window. The toolbar
  // controls (color/tool/undo/redo/clear) live inline in RecordPage instead of a second
  // window.
  { path: "annotate/draw", element: <AnnotationDrawPage /> },
]);
