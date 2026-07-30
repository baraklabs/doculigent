import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import logo from "../../assets/logo.png";
import { planLabel } from "@shared/constants/plans";
import { useAuthStore } from "../../store/authStore";
import { useSavingRecording, watchRecordingSaves } from "../../store/recordingStore";
import { useMeetingRecordingStore } from "../../store/meetingRecordingStore";
import { RecordingSaveToast } from "../../components/RecordingSaveToast";
import { ToastStack } from "../../components/ToastStack";
import { initials } from "../../lib/userDisplay";
import "./Layout.css";

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL).replace(/\/+$/, "");
const VERSION_ENDPOINT = `${SUPABASE_URL}/functions/v1/version`;
const DOWNLOAD_URL = "https://doculigent.com";
const DOCS_URL = "https://doculigent.com";

const SAVING_HINT = "Saving your recording — you can switch tabs once it's done";
const MEETING_RECORDING_HINT = "Meeting is recording — stop it before switching tabs";

function WindowGlyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function isNewerVersion(latest: string, current: string) {
  const toParts = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const [la, lb, lc] = toParts(latest);
  const [ca, cb, cc] = toParts(current);
  return la !== ca ? la > ca : lb !== cb ? lb > cb : lc > cc;
}

const TABS: { to: string; label: string; end: boolean }[] = [
  { to: "/record", label: "Record", end: true },
  { to: "/meeting", label: "Meeting", end: true },
  { to: "/library", label: "Library", end: true },
  { to: "/edit", label: "Edit", end: false },
  { to: "/ai", label: "AI Assistant", end: false },
  { to: "/settings", label: "⚙ Settings", end: false },
];

export function Layout() {
  const [latestVersion, setLatestVersion] = useState<string>();
  const session = useAuthStore((s) => s.session);
  const initAuth = useAuthStore((s) => s.init);
  const location = useLocation();

  useEffect(() => {
    initAuth();
  }, [initAuth]);
  const savingRecording = useSavingRecording();
  const meetingRecording = useMeetingRecordingStore((s) => s.recording);
  const navLocked = savingRecording || meetingRecording;
  const navLockHint = savingRecording ? SAVING_HINT : meetingRecording ? MEETING_RECORDING_HINT : undefined;
  useEffect(() => {
    watchRecordingSaves();
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(VERSION_ENDPOINT, {
      headers: {
        "x-app-version": __APP_VERSION__,
        "x-platform": window.api.system.platform,
        "x-arch": window.api.system.arch,
      },
    })
      .then((res) => res.json())
      .then((data: { version?: string }) => {
        if (!cancelled && data.version) setLatestVersion(data.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    window.api.window.isMaximized().then(setMaximized);
    return window.api.window.onMaximizeChanged(setMaximized);
  }, []);

  const stagesRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const active = stagesRef.current?.querySelector<HTMLElement>(".stage.active");
    if (active) setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
  }, [location.pathname]);

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
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              onClick={(e) => {
                if (navLocked) e.preventDefault();
              }}
              aria-disabled={navLocked || undefined}
              title={navLockHint}
              className={({ isActive }) =>
                [isActive ? "stage active" : "stage", navLocked && !isActive && "stage-locked"]
                  .filter(Boolean)
                  .join(" ")
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>

        <div className="topbar-right">
          <NavLink
            to="/account"
            onClick={(e) => {
              if (navLocked) e.preventDefault();
            }}
            aria-disabled={navLocked || undefined}
            title={navLocked ? navLockHint : session ? session.user.name : "Sign in to doculigent.com"}
            className={({ isActive }) =>
              ["account-btn", isActive && "active", navLocked && !isActive && "stage-locked"]
                .filter(Boolean)
                .join(" ")
            }
          >
            <span className={session ? "user-avatar" : "user-avatar user-avatar-anon"}>
              {session ? (
                initials(session.user.name)
              ) : (
                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                  <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 1.5c-3.5 0-6.5 1.75-6.5 4v.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-.5c0-2.25-3-4-6.5-4Z" />
                </svg>
              )}
            </span>
            <span className="account-name">{session ? session.user.name : "Sign in"}</span>
          </NavLink>

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
              <WindowGlyph
                d={maximized ? "M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" : "M.5.5h9v9h-9z"}
              />
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
        </div>
      </header>

      <main className="workspace">
        <Outlet />
      </main>

      <RecordingSaveToast />
      <ToastStack />

      <footer className="footer">
        <div className="footer-version">
          <span className="muted">Doculigent v{__APP_VERSION__}</span>
          {latestVersion && isNewerVersion(latestVersion, __APP_VERSION__) && (
            <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer" className="update-available">
              New version v{latestVersion} available
            </a>
          )}
          <a href={DOCS_URL} target="_blank" rel="noreferrer" className="footer-link">
            Read docs
          </a>
        </div>
        {session?.user.plan && (
          <div className="footer-plan">
            <span className="footer-plan-tier">{planLabel(session.user.plan.tier)} plan</span>
          </div>
        )}
      </footer>
    </div>
  );
}
