import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { SettingsService } from "../../services/settings/SettingsService";
import { useToast } from "../../hooks/useToast";
import logo from "../../assets/logo.png";
import { planLabel } from "@shared/constants/plans";
import { useAuthStore } from "../../store/authStore";
import { useRecordingStore, useSavingRecording, watchRecordingSaves } from "../../store/recordingStore";
import { useMeetingRecordingStore } from "../../store/meetingRecordingStore";
import { RecordingSaveToast } from "../../components/RecordingSaveToast";
import { ToastStack } from "../../components/ToastStack";
import { SignInPrompt } from "../../components/SignInPrompt";
import { WindowControls } from "../../components/WindowControls";
import { initials } from "../../lib/userDisplay";
import { useThemeStore, type ColorMode } from "../../theme/theme";
import { warmAppCaches } from "../../lib/warmCaches";
import "./Layout.css";

const VERSION_ENDPOINT = "https://doculigent.com/version";
const DOWNLOAD_URL = "https://doculigent.com";
const DOCS_URL = "https://doculigent.com";

const SAVING_HINT = "Saving your recording — you can switch tabs once it's done";
const MEETING_RECORDING_HINT = "Meeting is recording — stop it before switching tabs";
const RECORDING_HINT = "Recording — use the floating dock to pause, restart, or stop";

const MODE_META: Record<ColorMode, { label: string; icon: JSX.Element }> = {
  auto: {
    label: "Auto",
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
        <path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor" />
      </svg>
    ),
  },
  light: {
    label: "Light",
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
      </svg>
    ),
  },
  dark: {
    label: "Dark",
    icon: (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
        <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z" />
      </svg>
    ),
  },
};

function ThemeToggle() {
  const mode = useThemeStore((s) => s.mode);
  const cycleMode = useThemeStore((s) => s.cycleMode);
  const next = ({ auto: "light", light: "dark", dark: "auto" } as const)[mode];
  return (
    <button
      type="button"
      className="win-btn theme-toggle"
      onClick={cycleMode}
      aria-label={`Theme: ${MODE_META[mode].label}. Switch to ${MODE_META[next].label}`}
      title={`Theme: ${MODE_META[mode].label} (click for ${MODE_META[next].label})`}
    >
      {MODE_META[mode].icon}
    </button>
  );
}

const SOCIAL_LINKS: { label: string; href: string; path: string; badge?: string }[] = [
  {
    label: "GitHub",
    href: "https://github.com/baraklabs/doculigent",
    path: "M12 .5C5.73.5.5 5.73.5 12c0 5.09 3.29 9.4 7.86 10.93.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.72.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.75 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.27-5.23-5.67 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.57.23 2.73.11 3.02.73.8 1.18 1.83 1.18 3.08 0 4.41-2.69 5.38-5.25 5.66.41.36.78 1.06.78 2.14 0 1.54-.01 2.79-.01 3.17 0 .31.21.67.8.56A10.51 10.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z",
  },
  {
    label: "X (Twitter)",
    href: "https://x.com/doculigent",
    path: "M18.24 2h3.06l-6.69 7.65L22.5 22h-6.16l-4.82-6.3L5.98 22H2.92l7.16-8.19L1.5 2h6.32l4.36 5.76L18.24 2Zm-1.08 18.17h1.7L7.03 3.74H5.2l11.96 16.43Z",
  },
  {
    label: "YouTube",
    href: "https://www.youtube.com/channel/UCspSulNS4JS-lnTUBzGd_jQ",
    path: "M23.5 6.5s-.23-1.64-.94-2.36c-.9-.95-1.9-.95-2.36-1.01C16.9 2.8 12 2.8 12 2.8h-.01s-4.9 0-8.2.33c-.46.06-1.46.06-2.36 1.01C.72 4.86.5 6.5.5 6.5S.26 8.42.26 10.35v1.3c0 1.93.24 3.85.24 3.85s.23 1.64.94 2.36c.9.95 2.08.92 2.6 1.02 1.88.18 8 .24 8 .24s4.9-.01 8.2-.33c.46-.06 1.46-.06 2.36-1.01.71-.72.94-2.36.94-2.36s.24-1.93.24-3.85v-1.3c0-1.93-.24-3.85-.24-3.85ZM9.65 14.87V7.83l6.34 3.53-6.34 3.51Z",
  },
  {
    label: "LinkedIn",
    badge: "#0A66C2", // full logo: white "in" on a blue rounded square, as on the website
    href: "https://www.linkedin.com/company/doculigent",
    path: "M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.38-1.85 3.61 0 4.27 2.38 4.27 5.47v6.27ZM5.34 7.43a2.07 2.07 0 1 1 0-4.13 2.07 2.07 0 0 1 0 4.13ZM7.12 20.45H3.56V9h3.56v11.45Z",
  },
];

// Module-level so it fires once per launch, not every time the layout remounts.
let signInPulseShown = false;
let telemetryNoticeShown = false;

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
  const authReady = useAuthStore((s) => s.ready);
  // Draw the eye to "Sign in" once per app launch (when signed out) with a short pulse.
  const [signInPulse, setSignInPulse] = useState(false);
  useEffect(() => {
    if (!authReady || session || signInPulseShown) return;
    signInPulseShown = true;
    setSignInPulse(true);
    const t = setTimeout(() => setSignInPulse(false), 5000);
    return () => clearTimeout(t);
  }, [authReady, session]);
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  useEffect(() => {
    initAuth();
  }, [initAuth]);
  // Pre-load tab data in the background so switching tabs paints from memory.
  useEffect(() => {
    warmAppCaches();
  }, []);
  const savingRecording = useSavingRecording();
  const meetingRecording = useMeetingRecordingStore((s) => s.recording);
  const recording = useRecordingStore((s) => s.recording);
  const navLocked = savingRecording || meetingRecording || recording;
  const navLockHint = savingRecording
    ? SAVING_HINT
    : meetingRecording
      ? MEETING_RECORDING_HINT
      : recording
        ? RECORDING_HINT
        : undefined;
  useEffect(() => {
    watchRecordingSaves();
  }, []);

  // First-launch notice about anonymous usage sharing (on by default; opt out in Settings).
  useEffect(() => {
    if (telemetryNoticeShown) return;
    telemetryNoticeShown = true;
    SettingsService.getTelemetryState()
      .then((state) => {
        if (state.noticeSeen) return;
        toast.info("Doculigent shares anonymous usage data to improve the app. You can turn this off in Settings.", {
          title: "Anonymous usage data",
          duration: 15000,
          action: {
            label: "Go to Settings > Preferences",
            onClick: () => navigate("/settings?section=preferences"),
          },
        });
        return SettingsService.markTelemetryNoticeSeen();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    SettingsService.getTelemetryState()
      .catch(() => ({ enabled: false, noticeSeen: true, installId: null }))
      .then((state) =>
        fetch(VERSION_ENDPOINT, {
          headers: {
            "x-app-version": __APP_VERSION__,
            "x-platform": window.api.system.platform,
            "x-arch": window.api.system.arch,
            ...(state.enabled && state.installId ? { "x-install-id": state.installId } : {}),
          },
        })
      )
      .then((res) => res.json())
      .then((data: { version?: string }) => {
        if (!cancelled && data.version) setLatestVersion(data.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);


  const stagesRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const active = stagesRef.current?.querySelector<HTMLElement>(".stage.active");
    setIndicator(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
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
              ["account-btn", isActive && "active", navLocked && !isActive && "stage-locked", signInPulse && !session && "account-btn-pulse"]
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

          <ThemeToggle />

          <WindowControls />
        </div>
      </header>

      <main className="workspace">
        <Outlet />
      </main>

      <RecordingSaveToast />
      <ToastStack />
      <SignInPrompt />

      <footer className="footer">
        <div className="footer-version">
          <span className="muted">Doculigent v{__APP_VERSION__}</span>
          {latestVersion && isNewerVersion(latestVersion, __APP_VERSION__) && (
            <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer" className="update-available" data-tooltip="Download new version" aria-label={`Download new version v${latestVersion}`}>
              New version v{latestVersion} available
            </a>
          )}
          <a href={`${DOCS_URL}/features`} target="_blank" rel="noreferrer" className="footer-link">
            Read docs
          </a>
          <a href="https://doculigent.com/contact-us" target="_blank" rel="noreferrer" className="footer-link">
            Contact us
          </a>
        </div>
        <div className="footer-social">
          <span className="footer-social-label">Learn more</span>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Doculigent website"
            title="doculigent.com"
            className="footer-social-website"
          >
            <img src={logo} alt="" className="footer-social-logo" />
          </a>
          {SOCIAL_LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              aria-label={l.label}
              title={l.label}
              className={`footer-social-${l.label.split(" ")[0].toLowerCase()}`}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                {l.badge && <rect width="24" height="24" rx="4.5" fill={l.badge} />}
                <path d={l.path} fill={l.badge ? "#fff" : undefined} />
              </svg>
            </a>
          ))}
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
