import { createHashRouter, Navigate } from "react-router-dom";
import { Layout } from "./layout/Layout";
import { RecordPage } from "../pages/RecordPage";
import { AnnotationDrawPage } from "../pages/AnnotationDrawPage";
import { CameraBubblePage } from "../pages/CameraBubblePage";
import { AreaSelectPage } from "../pages/AreaSelectPage";
import { RecordingDockPage } from "../pages/RecordingDockPage";
import { CountdownPage } from "../pages/CountdownPage";
import { RouteError } from "../components/RouteError";

/** Loads a page's code on first visit instead of in the startup bundle (keeps launch fast). */
const page = (load: () => Promise<Record<string, unknown>>, name: string) => ({
  lazy: async () => ({ Component: (await load())[name] as React.ComponentType }),
});

export const router = createHashRouter([
  {
    element: <Layout />,
    // Only reached if Layout itself throws; page errors are caught by the wrapper below.
    errorElement: <RouteError />,
    children: [
      {
        // Pathless wrapper: a page that throws shows <RouteError /> inside the Layout, so the
        // top bar and tabs stay usable instead of the whole window turning into an error screen.
        errorElement: <RouteError />,
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
    ],
  },
  { path: "annotate/draw", element: <AnnotationDrawPage />, errorElement: <RouteError /> },
  { path: "camera-bubble", element: <CameraBubblePage />, errorElement: <RouteError /> },
  { path: "area-select", element: <AreaSelectPage />, errorElement: <RouteError /> },
  { path: "recording-dock", element: <RecordingDockPage />, errorElement: <RouteError /> },
  { path: "countdown", element: <CountdownPage />, errorElement: <RouteError /> },
]);
