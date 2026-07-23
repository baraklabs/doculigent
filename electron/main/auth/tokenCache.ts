/** The doculigent.com access token, held in main-process memory only — never written to
 *  disk, the OS keychain, or sent to a renderer process. Cleared on logout and lost (by
 *  design) on app restart; see tokenManager.ts's getValidAccessToken for how a fresh one
 *  gets minted from the keychain-stored refresh token when that happens. */
let accessToken: string | null = null;
let expiresAt: string | null = null;

export function setAccessToken(token: string, expiry: string | null): void {
  accessToken = token;
  expiresAt = expiry;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getAccessTokenExpiry(): string | null {
  return expiresAt;
}

export function clearAccessToken(): void {
  accessToken = null;
  expiresAt = null;
}
