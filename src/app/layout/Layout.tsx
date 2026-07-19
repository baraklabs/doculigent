import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import logo from "../../assets/logo.png";
import { useAuthStore } from "../../store/authStore";
import { initials } from "../../lib/userDisplay";
import { useVideos } from "../../hooks/useVideos";

const APP_VERSION = "0.1.0";

// Split around the "Edit" tab, which — unlike the others — has no fixed route: it jumps
// into the Edit page for whichever recording was made/touched most recently (see the
// useVideos() lookup below), so it needs a dynamic `to` rather than a static one.
const TABS_BEFORE_EDIT: { to: string; label: string }[] = [
  { to: "/record", label: "Record" },
  { to: "/meeting", label: "Meeting" },
  { to: "/library", label: "Library" },
];
const TABS_AFTER_EDIT: { to: string; label: string }[] = [
  { to: "/ai", label: "AI Assistant" },
  { to: "/settings", label: "⚙ Settings" },
];

/** Top bar + tab nav + footer status, ported from the original App.tsx shell. */
export function Layout() {
  const [coreOnline, setCoreOnline] = useState(false);
  const session = useAuthStore((s) => s.session);
  const initAuth = useAuthStore((s) => s.init);
  const location = useLocation();
  const { data: videos = [] } = useVideos("");
  const latestVideoId = videos[0]?.id ?? null;

  useEffect(() => {
    initAuth();
  }, [initAuth]);

  // Sliding highlight behind the active tab — measured off the actual DOM node so it
  // tracks each tab's real width/position (labels aren't uniform width) instead of
  // guessing at fixed offsets.
  const stagesRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const active = stagesRef.current?.querySelector<HTMLElement>(".stage.active");
    if (active) setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
  }, [location.pathname, latestVideoId]);

  useEffect(() => {
    // Unlike the old Tauri app (a separate Rust sidecar that could genuinely be "not
    // running" yet), Electron's main process is always up by the time the renderer runs
    // at all — this is really just a sanity ping that the preload bridge is wired,
    // kept for visual parity with the original footer status dot.
    window.api.settings
      .getSaveDir()
      .then(() => setCoreOnline(true))
      .catch(() => setCoreOnline(false));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src={logo} alt="" className="brand-logo" />
          Doculigent
        </div>
        <nav className="stages" ref={stagesRef}>
          {indicator && (
            <span
              className="stage-indicator"
              style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
            />
          )}
          {TABS_BEFORE_EDIT.map((t) => (
            <NavLink key={t.to} to={t.to} end className={({ isActive }) => (isActive ? "stage active" : "stage")}>
              {t.label}
            </NavLink>
          ))}
          {latestVideoId ? (
            <NavLink
              to={`/library/${latestVideoId}/edit`}
              end
              className={({ isActive }) => (isActive ? "stage active" : "stage")}
            >
              Edit
            </NavLink>
          ) : (
            <button type="button" className="stage" disabled title="Record something first">
              Edit
            </button>
          )}
          {TABS_AFTER_EDIT.map((t) => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => (isActive ? "stage active" : "stage")}>
              {t.label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar-right">
          <NavLink to="/account" className={({ isActive }) => (isActive ? "account-btn active" : "account-btn")}>
            <span className="user-avatar">{session ? initials(session.user.name) : "\u{1F464}"}</span>
            {session && <span className="account-name">{session.user.name}</span>}
          </NavLink>

          {/* The window is frameless (see electron/main/window.ts) — this topbar is the
              drag handle, so these are the only way to minimize/close. */}
          <div className="window-controls">
            <button
              type="button"
              className="win-btn"
              onClick={() => window.api.window.minimize()}
              aria-label="Minimize"
            >
              &#x2013;
            </button>
            <button
              type="button"
              className="win-btn win-btn-close"
              onClick={() => window.api.window.close()}
              aria-label="Close"
            >
              &#x2715;
            </button>
          </div>
        </div>
      </header>

      <main className="workspace">
        <Outlet />
      </main>

      <footer className="footer">
        <div className="footer-status">
          <span className={coreOnline ? "status-dot online" : "status-dot"} />
          {coreOnline ? "Core connected" : "Core not running"}
        </div>
        <span className="muted">Doculigent v{APP_VERSION}</span>
      </footer>
    </div>
  );
}
