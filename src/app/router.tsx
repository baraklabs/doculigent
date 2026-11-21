import { createHashRouter, Navigate } from "react-router-dom";
import { Layout } from "./layout/Layout";
import { RecordPage } from "../pages/RecordPage";
import { AnnotationDrawPage } from "../pages/AnnotationDrawPage";
import { CameraBubblePage } from "../pages/CameraBubblePage";
import { AreaSelectPage } from "../pages/AreaSelectPage";
import { RecordingDockPage } from "../pages/RecordingDockPage";
import { CountdownPage } from "../pages/CountdownPage";

/** Loads a page's code on first visit instead of in the startup bundle (keeps launch fast). */
const page = (load: () => Promise<Record<string, unknown>>, name: string) => ({
  lazy: async () => ({ Component: (await load())[name] as React.ComponentType }),
});

export const router = createHashRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/record" replace /> },
      { path: "record", element: <RecordPage /> },
      { path: "meeting", ...page(() => import("../pages/MeetingPage"), "MeetingPage") },
      { path: "library", ...page(() => import("../pages/LibraryPage"), "LibraryPage") },
      { path: "edit", ...page(() => import("../pages/EditPage"), "EditPage") },
      { path: "edit/:id", ...page(() => import("../pages/EditPage"), "EditPage") },
      { path: "library/:id/ai", ...page(() => import("../pages/AiPage"), "AiPage") },
      { path: "ai", ...page(() => import("../pages/AiAssistantPage"), "AiAssistantPage") },
      { path: "library/:id/share", ...page(() => import("../pages/SharePage"), "SharePage") },
      { path: "settings", ...page(() => import("../pages/SettingsPage"), "SettingsPage") },
      { path: "account", ...page(() => import("../pages/AccountPage"), "AccountPage") },
    ],
  },
  { path: "annotate/draw", element: <AnnotationDrawPage /> },
  { path: "camera-bubble", element: <CameraBubblePage /> },
  { path: "area-select", element: <AreaSelectPage /> },
  { path: "recording-dock", element: <RecordingDockPage /> },
  { path: "countdown", element: <CountdownPage /> },
]);
