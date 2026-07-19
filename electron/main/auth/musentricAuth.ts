/**
 * doculigent.com sign-in: OAuth 2.0 Authorization Code + PKCE (RFC 7636), browser-based per
 * RFC 8252. `login()` opens the system browser and then races two ways to get the
 * authorization code back:
 *  - automatic: the browser redirects to a loopback server this process spins up
 *  - manual: doculigent.com also shows the code on-page, and the user pastes it into the
 *    Account page, which calls `submitManualCode`
 * Whichever arrives first wins. Tokens go in the OS keychain (keyring.ts); the non-secret
 * profile goes in settings.json (settingsStore.ts) so the header can show the user's name
 * without an extra roundtrip on every launch.
 */
import { app, BrowserWindow, shell } from "electron";
import { Channels } from "@shared/constants/channels";
import { AUTH_CONFIG } from "@shared/constants/authConfig";
import type { AuthSession, AuthUser, LoginStatus } from "@shared/types/auth";
import { generateCodeVerifier, deriveCodeChallenge, generateState } from "./pkce";
import { LoopbackServer, type LoopbackResult } from "./loopbackServer";
import { setAuthTokens, getAuthTokens, clearAuthTokens } from "../native/keyring";
import { getAuthProfile, setAuthProfile, clearAuthProfile } from "../native/settingsStore";

class LoginCancelledError extends Error {}

interface PendingLogin {
  state: string;
  loopback: LoopbackServer;
  manualCode: { resolve: (code: string) => void; reject: (err: Error) => void } | null;
}

let pending: PendingLogin | null = null;

export async function getSession(): Promise<AuthSession | null> {
  const [tokens, profile] = await Promise.all([getAuthTokens(), Promise.resolve(getAuthProfile())]);
  if (!tokens || !profile) return null;
  return { user: profile.user, expiresAt: profile.expiresAt };
}

export async function login(): Promise<AuthSession> {
  if (pending) throw new Error("A login is already in progress");

  const verifier = generateCodeVerifier();
  const challenge = deriveCodeChallenge(verifier);
  const state = generateState();
  const loopback = await LoopbackServer.start();

  pending = { state, loopback, manualCode: null };
  await broadcast({ phase: "awaitingCallback" });

  await shell.openExternal(buildAuthorizeUrl(challenge, state, loopback.redirectUri));

  try {
    const manualResult = new Promise<LoopbackResult>((resolve, reject) => {
      pending!.manualCode = { resolve: (code) => resolve({ code, state }), reject };
    });

    const result = await Promise.race([loopback.waitForCallback(), manualResult]);
    if (result.state !== state) throw new Error("Login state mismatch — please try again");

    await broadcast({ phase: "exchangingCode" });
    const session = await exchangeCode(result.code, verifier, loopback.redirectUri);
    await broadcast({ phase: "idle" });
    return session;
  } catch (err) {
    if (err instanceof LoginCancelledError) {
      await broadcast({ phase: "idle" });
    } else {
      await broadcast({ phase: "error", message: err instanceof Error ? err.message : String(err) });
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

export async function cancelLogin(): Promise<void> {
  if (!pending) return;
  pending.manualCode?.reject(new LoginCancelledError("Login cancelled"));
  pending.loopback.close();
}

/** Dev-only shortcut for exercising the logged-in UI without a live doculigent.com
 *  backend (there isn't one yet). Refuses to run in packaged builds so it can never ship. */
export async function devLogin(): Promise<AuthSession> {
  if (app.isPackaged) throw new Error("Dev login is only available in development builds");

  const user: AuthUser = { id: "dev-user", name: "Dev Tester", email: "dev@doculigent.com" };
  await setAuthTokens({ accessToken: "dev-token", refreshToken: null });
  setAuthProfile(user, null);
  await broadcast({ phase: "idle" });
  return { user, expiresAt: null };
}

export async function logout(): Promise<void> {
  await clearAuthTokens();
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

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<AuthSession> {
  const tokenRes = await fetch(AUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: AUTH_CONFIG.clientId,
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`doculigent.com sign-in failed (${tokenRes.status})`);
  const tokenBody = (await tokenRes.json()) as TokenResponse;

  const user = await fetchProfile(tokenBody.access_token);
  const expiresAt = tokenBody.expires_in ? new Date(Date.now() + tokenBody.expires_in * 1000).toISOString() : null;

  await setAuthTokens({ accessToken: tokenBody.access_token, refreshToken: tokenBody.refresh_token ?? null });
  setAuthProfile(user, expiresAt);

  return { user, expiresAt };
}

async function fetchProfile(accessToken: string): Promise<AuthUser> {
  const res = await fetch(AUTH_CONFIG.userInfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Could not load your doculigent.com profile (${res.status})`);
  const body = (await res.json()) as { id?: string; sub?: string; name?: string; email?: string };
  return {
    id: body.id ?? body.sub ?? "",
    name: body.name ?? body.email ?? "Doculigent user",
    email: body.email ?? "",
  };
}

async function broadcast(status: LoginStatus): Promise<void> {
  const session = await getSession();
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(Channels.auth.sessionChanged, session, status);
  }
}
