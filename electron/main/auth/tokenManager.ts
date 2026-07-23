/** doculigent.com token exchange + refresh (RFC 6749 §4.1.3 / §6). Owns every call to
 *  /oauth/token and is the single place that writes the access token into memory
 *  (tokenCache.ts) and rotates the refresh token in the OS keychain (keyring.ts). Both
 *  doculigentAuth.ts (initial login, logout) and apiClient.ts (401 retry) go through here
 *  rather than touching those stores directly. */
import { AUTH_CONFIG } from "@shared/constants/authConfig";
import { setRefreshToken, getRefreshToken, clearRefreshToken } from "../native/keyring";
import { setAccessToken, getAccessToken, clearAccessToken } from "./tokenCache";

/** Wraps an OAuth `error` response from /oauth/token (RFC 6749 §5.2) — e.g. `invalid_grant`
 *  for an expired/already-used authorization code, or a revoked/expired refresh token. */
export class OAuthTokenError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OAuthTokenError";
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface AppliedTokens {
  accessToken: string;
  expiresAt: string | null;
}

async function requestToken(params: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetch(AUTH_CONFIG.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  } catch {
    throw new Error("Couldn't reach doculigent.com — check your connection and try again.");
  }

  if (!res.ok) {
    let code = "server_error";
    let description: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; error_description?: string };
      code = body.error ?? code;
      description = body.error_description;
    } catch {
      // Non-JSON error body — fall back to the generic message below.
    }
    throw new OAuthTokenError(code, description ?? `doculigent.com sign-in failed (${res.status}: ${code})`);
  }
  return (await res.json()) as TokenResponse;
}

async function applyTokenResponse(body: TokenResponse): Promise<AppliedTokens> {
  const expiresAt = body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null;
  setAccessToken(body.access_token, expiresAt);
  // Refresh tokens are typically rotated on every use — always persist whatever the
  // server just handed back so the old (now possibly invalidated) one isn't reused.
  if (body.refresh_token) await setRefreshToken(body.refresh_token);
  return { accessToken: body.access_token, expiresAt };
}

export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string
): Promise<AppliedTokens> {
  const body = await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: AUTH_CONFIG.clientId,
    code_verifier: verifier,
  });
  return applyTokenResponse(body);
}

let refreshInFlight: Promise<string> | null = null;

/** Redeems the keychain-stored refresh token for a new access token. Concurrent callers
 *  (e.g. two API calls 401-ing at once) share one in-flight request rather than each
 *  racing to rotate the refresh token. Clears all local auth state if the refresh token
 *  turns out to be expired or revoked. */
export function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) throw new OAuthTokenError("invalid_grant", "Not signed in");
    try {
      const body = await requestToken({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: AUTH_CONFIG.clientId,
      });
      return (await applyTokenResponse(body)).accessToken;
    } catch (err) {
      if (err instanceof OAuthTokenError && (err.code === "invalid_grant" || err.code === "invalid_token")) {
        await clearRefreshToken();
        clearAccessToken();
      }
      throw err;
    }
  })();

  return refreshInFlight.finally(() => {
    refreshInFlight = null;
  });
}

/** The in-memory access token if one is cached, otherwise a freshly-refreshed one if a
 *  refresh token exists — or null if there's no session at all. Never throws: a failed
 *  refresh (revoked/expired token, network error) just means "not signed in". */
export async function getValidAccessToken(): Promise<string | null> {
  const cached = getAccessToken();
  if (cached) return cached;
  try {
    return await refreshAccessToken();
  } catch {
    return null;
  }
}
