import { useState } from "react";
import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router-dom";
import "./RouteError.css";

function describe(error: unknown): { message: string; details: string } {
  if (isRouteErrorResponse(error)) {
    return { message: `${error.status} ${error.statusText}`, details: JSON.stringify(error.data ?? "", null, 2) };
  }
  if (error instanceof Error) {
    return { message: error.message, details: error.stack ?? error.message };
  }
  const text = typeof error === "string" ? error : JSON.stringify(error);
  return { message: text || "Unknown error", details: text || "Unknown error" };
}

/** Shown in place of a page that threw while rendering (react-router `errorElement`).
 *  Replaces the library's default "Unexpected Application Error!" screen: the rest of the app
 *  (top bar, tabs) keeps working, the user can retry or go home, and the technical details are
 *  one click away to copy into a bug report. Nothing is sent anywhere automatically. */
export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const { message, details } = describe(error);
  // eslint-disable-next-line no-console
  console.error("[route error]", error);

  const report = [
    `Doculigent ${__APP_VERSION__} (${window.api?.system?.platform ?? "?"}/${window.api?.system?.arch ?? "?"})`,
    `Page: ${window.location.hash || "/"}`,
    "",
    details,
  ].join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard unavailable — details are still visible below */
    }
  }

  return (
    <div className="route-error panel">
      <h2>Something went wrong on this page</h2>
      <p className="muted">
        The rest of the app is fine. Try again, or go back to Record. If it keeps happening, copy the details and send
        them to us.
      </p>
      <p className="route-error-message">{message}</p>
      <div className="actions">
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        <button type="button" onClick={() => navigate("/record", { replace: true })}>
          Go to Record
        </button>
        <button type="button" onClick={copy}>
          {copied ? "Copied ✓" : "Copy error details"}
        </button>
      </div>
      <details>
        <summary className="muted">Technical details</summary>
        <pre className="route-error-details">{report}</pre>
      </details>
    </div>
  );
}
