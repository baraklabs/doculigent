import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cloud, Eye, Share2, Sparkles, Users } from "lucide-react";
import { useAuthStore } from "../store/authStore";
import { WindowControls } from "./WindowControls";
import "../pages/AccountPage.css";
import "./SignInPrompt.css";

export const SIGN_IN_FEATURES = [
  { icon: Share2, title: "Instant file sharing" },
  { icon: Users, title: "Create teams" },
  { icon: Eye, title: "Track impressions" },
  { icon: Sparkles, title: "Best-in-class AI models" },
  { icon: Cloud, title: "Secure cloud storage" },
] as const;

const NEXT_PROMPT_KEY = "signInPrompt.nextAt";
const REMIND_MS = 30 * 24 * 60 * 60 * 1000;

function isDue(): boolean {
  try {
    const next = Number(localStorage.getItem(NEXT_PROMPT_KEY));
    return !Number.isFinite(next) || Date.now() >= next;
  } catch {
    return false; // storage unavailable — never nag
  }
}

function snooze30Days() {
  try {
    localStorage.setItem(NEXT_PROMPT_KEY, String(Date.now() + REMIND_MS));
  } catch {
    /* ignore */
  }
}

/**
 * Full-window "sign in" offer, shown at most once every 30 days at app launch to signed-out
 * users. Showing it counts as the once-per-30-days, so a plain restart won't bring it back;
 * "Remind me in 30 days" simply closes it.
 */
export function SignInPrompt() {
  const session = useAuthStore((s) => s.session);
  const ready = useAuthStore((s) => s.ready);
  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  // Decided once, synchronously on the first render, so the cover is already in place on the very
  // first paint — otherwise the header/footer show for a moment until the sign-in check finishes.
  const [due] = useState(isDue);
  const [dismissed, setDismissed] = useState(false);
  const setOpen = (open: boolean) => setDismissed(!open);
  const snoozed = useRef(false);

  // Showing the offer is what uses up this 30-day slot.
  useEffect(() => {
    if (!due || !ready || session || snoozed.current) return;
    snoozed.current = true;
    snooze30Days();
  }, [due, ready, session]);

  // Hold the content back until the app fonts are loaded: laying it out with the fallback font and then
  // re-laying it out when Inter arrives is what made the whole block shift a little after a moment.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    if (!due) return;
    let alive = true;
    const done = () => alive && setFontsReady(true);
    const loads = ["400 14px Inter", "600 14px Inter", "700 16px Inter"].map((f) => document.fonts.load(f));
    Promise.all(loads).then(done, done);
    const timeout = setTimeout(done, 5000); // never leave the offer blank if a font fails to load
    return () => {
      alive = false;
      clearTimeout(timeout);
    };
  }, [due]);

  // Covers the app from the first paint; stays a blank cover until we know whether the user is signed
  // in, then either shows the offer (signed out) or goes away (signed in, or after being dismissed).
  const open = due && !dismissed && (!ready || !session);
  if (!open) return null;

  return (
    <div className="signin-prompt" role="dialog" aria-modal="true" aria-label="Sign in to Doculigent">
      <div className="signin-prompt-bar">
        <WindowControls />
      </div>
      {ready && fontsReady && (
      <div className="signin-prompt-card">
        <h2>Create your account in Doculigent</h2>

        <button
          type="button"
          className="primary signin-prompt-signin"
          onClick={() => {
            setOpen(false);
            navigate("/account");
            login();
          }}
        >
          Sign in
        </button>

        <button type="button" className="link-btn signin-prompt-remind" onClick={() => setOpen(false)}>
          <span className="signin-prompt-remind-main">Start using the app</span>
          <span className="signin-prompt-remind-sub">Remind me in 30 days</span>
        </button>

        <p className="signin-prompt-unlock">Unlock with Doculigent Cloud</p>
        <div className="account-features-grid">
          {SIGN_IN_FEATURES.map(({ icon: Icon, title }) => (
            <div key={title} className="account-feature">
              <span className="account-feature-icon">
                <Icon size={18} />
              </span>
              <h3>{title}</h3>
            </div>
          ))}
        </div>

        <p className="muted account-contact signin-prompt-help">
          Need help? Email us at <a href="mailto:hello@doculigent.com">hello@doculigent.com</a> or{" "}
          <a href="https://doculigent.com/contact-us" target="_blank" rel="noreferrer">
            contact us
          </a>
        </p>

      </div>
      )}
    </div>
  );
}
