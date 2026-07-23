/**
 * doculigent.com OAuth 2.1 Authorization Code + PKCE (RFC 7636) endpoints. This is a
 * public/native client (no client secret — PKCE is what makes that safe), matching the
 * standard desktop-app flow (RFC 8252): browser-based login, loopback redirect.
 *
 * /oauth/authorize, /oauth/token, and /oauth/logout are Next.js routes on the doculigent.com
 * web app itself (see doculigent-website's src/app/oauth/*); the profile endpoint isn't one
 * of those — it's the same Supabase edge function (auth-user) the website's own browser
 * login uses, since an OAuth-issued access token and a browser-login one are the same JWT
 * shape (see that repo's supabase/functions/_shared/jwt.ts).
 */

// VITE_WEB_URL comes from env/.env.development (http://localhost:3000) or
// env/.env.production (https://doculigent.com) — see electron.vite.config.ts's `main.
// envDir`. Baked in at build time like VITE_SUPABASE_URL is for the renderer (see
// src/app/layout/Layout.tsx), so a packaged production build never reads this from the
// OS environment at runtime.
const baseUrl = import.meta.env.VITE_WEB_URL.replace(/\/+$/, "");
const functionsBaseUrl = `${import.meta.env.VITE_SUPABASE_URL.replace(/\/+$/, "")}/functions/v1`;

export const AUTH_CONFIG = {
  authorizeUrl: `${baseUrl}/oauth/authorize`,
  tokenUrl: `${baseUrl}/oauth/token`,
  userInfoUrl: `${functionsBaseUrl}/auth-user`,
  logoutUrl: `${baseUrl}/oauth/logout`,
  clientId: "doculigent-desktop",
  scope: "openid profile email offline_access",
  /** 127.0.0.1 (not "localhost") avoids a DNS lookup and matches RFC 8252 §7.3's
   *  recommendation for the loopback redirect URI. Port is chosen at listen time. */
  loopbackHost: "127.0.0.1",
  loopbackPath: "/callback",
  /** Custom URI scheme registered with the OS (see electron/main/auth/deepLink.ts and
   *  electron-builder.yml's `protocols`) — an alternate, one-click callback path shown on
   *  doculigent.com's result page for browsers that block the loopback redirect fetch. */
  deepLinkScheme: "doculigent",
} as const;
