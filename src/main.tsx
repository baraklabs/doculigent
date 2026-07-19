import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
// Self-hosted (matches doculigent-website's next/font approach) so the app keeps its own
// copy instead of depending on a runtime request to Google Fonts.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
