import { BrowserWindow, shell } from "electron";
import { Channels } from "@shared/constants/channels";
import { GOOGLE_DRIVE_AUTH_CONFIG, GOOGLE_DRIVE_CONFIGURED } from "@shared/constants/authConfig";
import type { GoogleDriveStatus } from "@shared/types/storage";
import { generateCodeVerifier, deriveCodeChallenge, generateState } from "./pkce";
import { LoopbackServer } from "./loopbackServer";
import {
  getGoogleDriveAccessToken,
  setGoogleDriveAccessToken,
  clearGoogleDriveAccessToken,
  hasLiveGoogleDriveAccessToken,
} from "./googleDriveTokenCache";
import {
  getGoogleDriveRefreshToken,
  setGoogleDriveRefreshToken,
  clearGoogleDriveRefreshToken,
} from "../native/keyring";
import {
  getGoogleDriveAccount,
  setGoogleDriveAccount,
  clearGoogleDriveAccount,
} from "../native/settingsStore";

export class GoogleTokenError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GoogleTokenError";
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(GOOGLE_DRIVE_AUTH_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  } catch {
    throw new Error("Couldn't reach Google — check your connection and try again.");
  }
  if (!res.ok) {
    let errorCode = "unknown_error";
    let description = `Google sign-in failed (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: string; error_description?: string };
      errorCode = body.error ?? errorCode;
      description = body.error_description ?? body.error ?? description;
    } catch {}
    throw new GoogleTokenError(errorCode, description);
  }
  return (await res.json()) as TokenResponse;
}

async function fetchEmail(accessToken: string): Promise<string> {
  const res = await fetch(GOOGLE_DRIVE_AUTH_CONFIG.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Couldn't load your Google profile (${res.status}).`);
  const body = (await res.json()) as { email?: string };
  return body.email ?? "";
}

let refreshInFlight: Promise<string> | null = null;

export function refreshGoogleDriveAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = await getGoogleDriveRefreshToken();
    if (!refreshToken) throw new Error("Your Google Drive session expired — reconnect in Settings › Storage.");
    try {
      const body = await requestToken({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: GOOGLE_DRIVE_AUTH_CONFIG.clientId,
        client_secret: GOOGLE_DRIVE_AUTH_CONFIG.clientSecret,
      });
      setGoogleDriveAccessToken(body.access_token, body.expires_in);
      return body.access_token;
    } catch (err) {
      if (err instanceof GoogleTokenError && err.code === "invalid_grant") {
        await clearGoogleDriveRefreshToken();
        clearGoogleDriveAccessToken();
        clearGoogleDriveAccount();
      }
      throw err;
    }
  })();

  return refreshInFlight.finally(() => {
    refreshInFlight = null;
  });
}

export async function getValidGoogleDriveAccessToken(): Promise<string> {
  const cached = getGoogleDriveAccessToken();
  if (cached) return cached;
  return refreshGoogleDriveAccessToken();
}

export async function getGoogleDriveStatus(): Promise<GoogleDriveStatus> {
  const account = getGoogleDriveAccount();
  if (!account) return { connected: false, email: null };
  const hasRefreshToken = !!(await getGoogleDriveRefreshToken());
  if (!hasRefreshToken && !hasLiveGoogleDriveAccessToken()) return { connected: false, email: null };
  return { connected: true, email: account.email };
}

function buildAuthorizeUrl(challenge: string, state: string, redirectUri: string): string {
  const url = new URL(GOOGLE_DRIVE_AUTH_CONFIG.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", GOOGLE_DRIVE_AUTH_CONFIG.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", GOOGLE_DRIVE_AUTH_CONFIG.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

let activeLoopback: LoopbackServer | null = null;

export async function signInToGoogleDrive(): Promise<GoogleDriveStatus> {
  if (!GOOGLE_DRIVE_CONFIGURED) {
    throw new Error("Google Drive isn't configured in this build — missing MAIN_VITE_GOOGLE_DRIVE_CLIENT_ID / MAIN_VITE_GOOGLE_DRIVE_CLIENT_SECRET.");
  }

  activeLoopback?.cancel(new Error("Sign-in restarted"));

  const verifier = generateCodeVerifier();
  const challenge = deriveCodeChallenge(verifier);
  const state = generateState();
  const loopback = await LoopbackServer.start(GOOGLE_DRIVE_AUTH_CONFIG.loopbackPath, GOOGLE_DRIVE_AUTH_CONFIG.loopbackHost);
  activeLoopback = loopback;

  try {
    await shell.openExternal(buildAuthorizeUrl(challenge, state, loopback.redirectUri));
    const result = await loopback.waitForCallback();
    if (result.state !== state) throw new Error("Google sign-in state mismatch — please try again.");

    const body = await requestToken({
      grant_type: "authorization_code",
      code: result.code,
      redirect_uri: loopback.redirectUri,
      client_id: GOOGLE_DRIVE_AUTH_CONFIG.clientId,
      client_secret: GOOGLE_DRIVE_AUTH_CONFIG.clientSecret,
      code_verifier: verifier,
    });

    setGoogleDriveAccessToken(body.access_token, body.expires_in);
    if (body.refresh_token) await setGoogleDriveRefreshToken(body.refresh_token);
    const email = await fetchEmail(body.access_token);
    setGoogleDriveAccount({ email });

    const status: GoogleDriveStatus = { connected: true, email };
    broadcastStatus(status);
    return status;
  } finally {
    loopback.close();
    if (activeLoopback === loopback) activeLoopback = null;
  }
}

export async function signOutOfGoogleDrive(): Promise<void> {
  clearGoogleDriveAccessToken();
  await clearGoogleDriveRefreshToken();
  clearGoogleDriveAccount();
  broadcastStatus({ connected: false, email: null });
}

function broadcastStatus(status: GoogleDriveStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(Channels.googleDrive.statusChanged, status);
  }
}
