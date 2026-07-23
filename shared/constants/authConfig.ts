const baseUrl = import.meta.env.VITE_WEB_URL.replace(/\/+$/, "");
const functionsBaseUrl = `${import.meta.env.VITE_SUPABASE_URL.replace(/\/+$/, "")}/functions/v1`;

export const AUTH_CONFIG = {
  authorizeUrl: `${baseUrl}/oauth/authorize`,
  tokenUrl: `${baseUrl}/oauth/token`,
  userInfoUrl: `${functionsBaseUrl}/auth-user`,
  clientId: "doculigent-desktop",
  scope: "openid profile email offline_access",
  loopbackHost: "127.0.0.1",
  loopbackPath: "/callback",
} as const;
