import { useEffect, useState } from "react";

function WindowGlyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** Minimize / maximize / close for the frameless window (shared by the header and full-window overlays). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    window.api.window.isMaximized().then(setMaximized);
    return window.api.window.onMaximizeChanged(setMaximized);
  }, []);

  return (
    <div className="window-controls">
      <button
        type="button"
        className="win-btn"
        onClick={() => window.api.window.minimize()}
        aria-label="Minimize"
        title="Minimize"
      >
        <WindowGlyph d="M0 5h10" />
      </button>
      <button
        type="button"
        className="win-btn"
        onClick={() => window.api.window.toggleMaximize()}
        aria-label={maximized ? "Restore down" : "Maximize"}
        title={maximized ? "Restore down (F11)" : "Maximize (F11)"}
      >
        <WindowGlyph d={maximized ? "M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" : "M.5.5h9v9h-9z"} />
      </button>
      <button
        type="button"
        className="win-btn win-btn-close"
        onClick={() => window.api.window.close()}
        aria-label="Close"
        title="Close"
      >
        <WindowGlyph d="M.5.5l9 9M9.5.5l-9 9" />
      </button>
    </div>
  );
}
