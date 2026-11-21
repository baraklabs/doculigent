import { useEffect, useState, type FormEvent } from "react";
import type { AuthPlan } from "@shared/types/auth";
import { billingIntervalLabel, isBilledTier, planLabel } from "@shared/constants/plans";
import { useAuthStore } from "../store/authStore";
import { initials } from "../lib/userDisplay";
import { SIGN_IN_FEATURES } from "../components/SignInPrompt";
import "./AccountPage.css";


/** "You're on Pro (billed monthly)." — the interval is dropped for free tiers and unknown intervals. */
function planSummary(plan: AuthPlan): string {
  const interval = isBilledTier(plan.tier) ? billingIntervalLabel(plan.interval) : null;
  const head = `You're on ${planLabel(plan.tier)}${interval ? ` (${interval})` : ""}`;
  return `${head}.`;
}

function formatStartedAt(startedAt: string | null): string | null {
  if (!startedAt) return null;
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function AccountPage() {
  const { session, loginStatus, ready, init, login, submitManualCode, cancelLogin, logout } = useAuthStore();
  const [manualCode, setManualCode] = useState("");

  useEffect(() => {
    init();
  }, [init]);

  const loggingIn = loginStatus.phase === "awaitingCallback" || loginStatus.phase === "exchangingCode";

  async function handleManualSubmit(e: FormEvent) {
    e.preventDefault();
    const code = manualCode.trim();
    if (!code) return;
    setManualCode("");
    await submitManualCode(code);
  }

  return (
    <div className="account-page">
      <section className={`panel account-card${ready && !session ? " account-card-signin" : ""}`}>
        {(!ready || session) && <h1>Account</h1>}

        {!ready && <p className="muted">Loading…</p>}

        {ready && session && (
          <>
            <div className="account-profile">
              <span className="user-avatar user-avatar-lg">{initials(session.user.name)}</span>
              <h3>{session.user.name}</h3>
              <p className="muted">{session.user.email}</p>
            </div>

            {session.user.plan && (
              <div className="account-plan">
                <p>{planSummary(session.user.plan)}</p>
                {formatStartedAt(session.user.plan.startedAt) && (
                  <p className="muted">Since {formatStartedAt(session.user.plan.startedAt)}</p>
                )}
              </div>
            )}
            <div className="actions">
              <button type="button" className="danger" onClick={() => logout()}>
                Sign out
              </button>
            </div>
          </>
        )}

        {ready && !session && (
          <>
            {!loggingIn && (
              <div className="actions">
                <button type="button" className="primary" onClick={() => login()}>
                  Sign in with doculigent.com
                </button>
              </div>
            )}

            {loggingIn && (
              <div className="notice account-login-pending">
                <p>
                  {loginStatus.phase === "awaitingCallback"
                    ? "Continue in the browser window that just opened — you'll be signed in automatically once you finish."
                    : "Finishing sign-in…"}
                </p>

                {loginStatus.phase === "awaitingCallback" && (
                  <form className="field" onSubmit={handleManualSubmit}>
                    <span>Or, if the browser didn't redirect back, paste the code shown on doculigent.com</span>
                    <div className="save-location">
                      <input
                        type="text"
                        value={manualCode}
                        onChange={(e) => setManualCode(e.target.value)}
                        placeholder="Enter code manually"
                      />
                      <button type="submit" disabled={!manualCode.trim()}>
                        Submit
                      </button>
                    </div>
                  </form>
                )}

                <div className="actions">
                  <button type="button" onClick={() => cancelLogin()}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {loginStatus.phase === "error" && <p className="error">{loginStatus.message}</p>}
          </>
        )}
      </section>

      {ready && !session && !loggingIn && (
        <section className="account-features" aria-label="What you get when you sign in">
          <h2>Unlock with Doculigent Cloud</h2>
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
        </section>
      )}

      {ready && !session && !loggingIn && (
        <p className="muted account-contact">
          Need help? Email us at <a href="mailto:hello@doculigent.com">hello@doculigent.com</a> or{" "}
          <a href="https://doculigent.com/contact-us" target="_blank" rel="noreferrer">contact us</a>
        </p>
      )}
    </div>
  );
}
