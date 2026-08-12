import { BrowserWindow, shell } from "electron";
import { Channels } from "@shared/constants/channels";
import { AUTH_CONFIG, AUTH_CONFIGURED } from "@shared/constants/authConfig";
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
/** Guards the one-shot profile backfill below so a plan-less API can't cause a fetch loop. */
let planBackfillAttempted = false;

export async function getSession(): Promise<AuthSession | null> {
  const profile = getAuthProfile();
  if (!profile) return null;
  if (!getAccessToken()) {
    try {
      await refreshAccessToken();
    } catch (err) {
      if (err instanceof OAuthTokenError) clearAuthProfile();
      return null;
    }
  }

  // Sessions created before plan support have no plan on file; re-fetch the profile once
  // per app run so the Account page shows the subscription without a forced re-login.
  if (!profile.user.plan && !planBackfillAttempted) {
    planBackfillAttempted = true;
    try {
      const user = await fetchProfile();
      setAuthProfile(user, profile.expiresAt);
      return { user, expiresAt: profile.expiresAt };
    } catch {
      // Offline or endpoint unavailable — keep the stored profile as-is.
    }
  }

  return { user: profile.user, expiresAt: profile.expiresAt };
}

export async function login(): Promise<AuthSession> {
  if (!AUTH_CONFIGURED) {
    throw new Error(
      "Sign-in isn't available in this build — it's missing VITE_WEB_URL/VITE_SUPABASE_URL (set in env/.env.production before building)."
    );
  }
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
  await forceSignOut();
}

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

interface UserInfoResponse {
  user?: {
    id?: string;
    name?: string | null;
    email?: string;
    plan?: {
      tier?: string;
      interval?: string;
      startedAt?: string | null;
      priceUsd?: number | null;
    } | null;
  };
}

async function fetchProfile(): Promise<AuthUser> {
  const res = await authorizedFetch(AUTH_CONFIG.userInfoUrl);
  if (!res.ok) throw new Error(`Could not load your doculigent.com profile (${res.status})`);
  const body = (await res.json()) as UserInfoResponse;
  if (!body.user) throw new Error("Could not load your doculigent.com profile.");
  const plan = body.user.plan;
  return {
    id: body.user.id ?? "",
    name: body.user.name ?? body.user.email ?? "Doculigent user",
    email: body.user.email ?? "",
    plan: plan
      ? {
          tier: plan.tier ?? "free",
          interval: plan.interval ?? "",
          startedAt: plan.startedAt ?? null,
          priceUsd: plan.priceUsd ?? null,
        }
      : null,
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
