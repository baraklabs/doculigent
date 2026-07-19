/**
 * doculigent.com OAuth 2.0 Authorization Code + PKCE (RFC 7636) endpoints. This is a
 * public/native client (no client secret — PKCE is what makes that safe), matching the
 * standard desktop-app flow (RFC 8252): browser-based login, loopback redirect.
 *
 * These paths are the assumed contract for doculigent.com's not-yet-built auth backend;
 * update this one file if the real API lands with different routes.
 */
export const AUTH_CONFIG = {
  authorizeUrl: "https://doculigent.com/oauth/authorize",
  tokenUrl: "https://doculigent.com/oauth/token",
  userInfoUrl: "https://doculigent.com/oauth/userinfo",
  clientId: "doculigent-desktop",
  scope: "openid profile email offline_access",
  /** 127.0.0.1 (not "localhost") avoids a DNS lookup and matches RFC 8252 §7.3's
   *  recommendation for the loopback redirect URI. Port is chosen at listen time. */
  loopbackHost: "127.0.0.1",
  loopbackPath: "/callback",
} as const;
