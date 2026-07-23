/**
 * doculigent.com sign-in: OAuth 2.1 Authorization Code + PKCE (RFC 7636), browser-based per
 * RFC 8252. `login()` opens the system browser and then races three ways to get the
 * authorization code back:
 *  - automatic: the browser redirects to a loopback server this process spins up
 *  - click-through: doculigent.com's result page also offers a doculigent://callback link,
 *    for browsers that block the loopback redirect fetch (see deepLink.ts)
 *  - manual: doculigent.com also shows the code on-page, and the user pastes it into the
 *    Account page, which calls `submitManualCode`
 * Whichever arrives first wins. The access token lives in main-process memory only
 * (tokenCache.ts) and is never sent to a renderer; the refresh token is the only secret
 * that touches disk, via the OS keychain (keyring.ts). The non-secret profile goes in
 * settings.json (settingsStore.ts) so the header can show the user's name without an
 * extra IPC round trip once a session is loaded.
 */
import { BrowserWindow, shell } from "electron";
import { Channels } from "@shared/constants/channels";
import { AUTH_CONFIG } from "@shared/constants/authConfig";
import type { AuthSession, AuthUser, LoginStatus } from "@shared/types/auth";
import { generateCodeVerifier, deriveCodeChallenge, generateState } from "./pkce";
import { LoopbackServer, type LoopbackResult } from "./loopbackServer";
import { exchangeAuthorizationCode, refreshAccessToken, OAuthTokenError } from "./tokenManager";
import { clearAccessToken, getAccessToken } from "./tokenCache";
import { clearRefreshToken, getRefreshToken } from "../native/keyring";
import { authorizedFetch } from "./apiClient";
import { getAuthProfile, setAuthProfile, clearAuthProfile } from "../native/settingsStore";

class LoginCancelledError extends Error {}

interface PendingLogin {
  state: string;
  loopback: LoopbackServer;
  manualCode: { resolve: (code: string) => void; reject: (err: Error) => void } | null;
  deepLink: { resolve: (r: LoopbackResult) => void; reject: (err: Error) => void } | null;
}

let pending: PendingLogin | null = null;

export async function getSession(): Promise<AuthSession | null> {
  const profile = getAuthProfile();
  if (!profile) return null;
  if (getAccessToken()) return { user: profile.user, expiresAt: profile.expiresAt };

  // No access token cached in memory (fresh launch, or it expired) — try to mint one from
  // the keychain-stored refresh token before deciding there's no session.
  try {
    await refreshAccessToken();
    return { user: profile.user, expiresAt: profile.expiresAt };
  } catch (err) {
    // A definite rejection (no refresh token, or the server said it's expired/revoked) —
    // genuinely signed out, so drop the stale local profile too. A transient failure
    // (network down) leaves the profile in place: report "no session" for now without
    // discarding it, so the next call retries instead of forcing a re-login once
    // connectivity returns.
    if (err instanceof OAuthTokenError) clearAuthProfile();
    return null;
  }
}

export async function login(): Promise<AuthSession> {
  if (pending) throw new Error("A login is already in progress");

  const verifier = generateCodeVerifier();
  const challenge = deriveCodeChallenge(verifier);
  const state = generateState();
  const loopback = await LoopbackServer.start();

  pending = { state, loopback, manualCode: null, deepLink: null };
  await broadcast({ phase: "awaitingCallback" });

  await shell.openExternal(buildAuthorizeUrl(challenge, state, loopback.redirectUri));

  try {
    const manualResult = new Promise<LoopbackResult>((resolve, reject) => {
      pending!.manualCode = { resolve: (code) => resolve({ code, state }), reject };
    });
    const deepLinkResult = new Promise<LoopbackResult>((resolve, reject) => {
      pending!.deepLink = { resolve, reject };
    });

    const result = await Promise.race([loopback.waitForCallback(), manualResult, deepLinkResult]);
    if (result.state !== state) throw new Error("Login state mismatch — please try signing in again.");

    await broadcast({ phase: "exchangingCode" });
    const { expiresAt } = await exchangeAuthorizationCode(result.code, verifier, loopback.redirectUri);
    const user = await fetchProfile();
    setAuthProfile(user, expiresAt);
    await broadcast({ phase: "idle" });
    return { user, expiresAt };
  } catch (err) {
    if (err instanceof LoginCancelledError) {
      await broadcast({ phase: "idle" });
    } else {
      await broadcast({ phase: "error", message: describeLoginError(err) });
    }
    throw err;
  } finally {
    loopback.close();
    pending = null;
  }
}

export function submitManualCode(code: string): void {
  if (!pending?.manualCode) throw new Error("No login is in progress");
  const trimmed = code.trim();
  if (!trimmed) throw new Error("Enter the code shown on doculigent.com");
  pending.manualCode.resolve(trimmed);
}

/** Wired up to the OS-level doculigent://callback handlers in deepLink.ts. A no-op if no
 *  login is currently awaiting a callback (e.g. a stale or replayed link). */
export function handleDeepLinkCallback(rawUrl: string): void {
  if (!pending?.deepLink) return;
  const { deepLink } = pending;
  try {
    const url = new URL(rawUrl);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (error) {
      deepLink.reject(new Error(url.searchParams.get("error_description") ?? error));
    } else if (code && state) {
      deepLink.resolve({ code, state });
    } else {
      deepLink.reject(new Error("Callback link was missing code/state"));
    }
  } catch {
    deepLink.reject(new Error("Malformed callback link"));
  }
}

export async function cancelLogin(): Promise<void> {
  if (!pending) return;
  pending.manualCode?.reject(new LoginCancelledError("Login cancelled"));
  pending.deepLink?.reject(new LoginCancelledError("Login cancelled"));
  pending.loopback.close();
}

export async function logout(): Promise<void> {
  const refreshToken = await getRefreshToken();
  if (refreshToken) {
    try {
      await fetch(AUTH_CONFIG.logoutUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch {
      // Best-effort: doculigent.com being unreachable shouldn't block signing out locally.
    }
  }
  await forceSignOut();
}

/** Clears every trace of the session — memory access token, keychain refresh token, and
 *  the local profile — without calling the logout endpoint. Used by logout() after (or
 *  instead of, on failure) the server round trip, and by anything that discovers the
 *  refresh token has been revoked. */
async function forceSignOut(): Promise<void> {
  clearAccessToken();
  await clearRefreshToken();
  clearAuthProfile();
  await broadcast({ phase: "idle" });
}

function buildAuthorizeUrl(challenge: string, state: string, redirectUri: string): string {
  const url = new URL(AUTH_CONFIG.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", AUTH_CONFIG.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", AUTH_CONFIG.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function fetchProfile(): Promise<AuthUser> {
  const res = await authorizedFetch(AUTH_CONFIG.userInfoUrl);
  if (!res.ok) throw new Error(`Could not load your doculigent.com profile (${res.status})`);
  const body = (await res.json()) as { user?: { id?: string; name?: string | null; email?: string } };
  if (!body.user) throw new Error("Could not load your doculigent.com profile.");
  return {
    id: body.user.id ?? "",
    name: body.user.name ?? body.user.email ?? "Doculigent user",
    email: body.user.email ?? "",
  };
}

function describeLoginError(err: unknown): string {
  if (err instanceof OAuthTokenError) {
    if (err.code === "invalid_grant") {
      return "That sign-in link expired or was already used — please try signing in again.";
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

async function broadcast(status: LoginStatus): Promise<void> {
  const session = await getSession();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(Channels.auth.sessionChanged, session, status);
  }
}
