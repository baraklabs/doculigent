import { useEffect, useState, type FormEvent } from "react";
import { useAuthStore } from "../store/authStore";
import { initials } from "../lib/userDisplay";

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
      <section className="panel account-card">
        <h1>Account</h1>

        {!ready && <p className="muted">Loading…</p>}

        {ready && session && (
          <>
            <div className="account-profile">
              <span className="user-avatar user-avatar-lg">{initials(session.user.name)}</span>
              <h3>{session.user.name}</h3>
              <p className="muted">{session.user.email}</p>
            </div>
            <div className="actions">
              <button type="button" className="danger" onClick={() => logout()}>
                Sign out
              </button>
            </div>
          </>
        )}

        {ready && !session && (
          <>
            <p className="muted">Sign in with your doculigent.com account to unlock cloud sharing and sync.</p>

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
    </div>
  );
}
