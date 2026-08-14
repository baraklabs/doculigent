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
import { CameraBubblePage } from "../pages/CameraBubblePage";
import { AreaSelectPage } from "../pages/AreaSelectPage";

export const router = createHashRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/record" replace /> },
      { path: "record", element: <RecordPage /> },
      { path: "meeting", element: <MeetingPage /> },
      { path: "library", element: <LibraryPage /> },
      { path: "edit", element: <EditPage /> },
      { path: "library/:id/ai", element: <AiPage /> },
      { path: "ai", element: <AiAssistantPage /> },
      { path: "library/:id/share", element: <SharePage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "account", element: <AccountPage /> },
    ],
  },
  { path: "annotate/draw", element: <AnnotationDrawPage /> },
  { path: "camera-bubble", element: <CameraBubblePage /> },
  { path: "area-select", element: <AreaSelectPage /> },
]);
