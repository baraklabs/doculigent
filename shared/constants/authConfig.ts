export const AUTH_CONFIGURED = Boolean(import.meta.env.VITE_WEB_URL && import.meta.env.VITE_SUPABASE_URL);

const baseUrl = (import.meta.env.VITE_WEB_URL ?? "").replace(/\/+$/, "");
const functionsBaseUrl = `${(import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "")}/functions/v1`;

export const FUNCTIONS_BASE_URL = functionsBaseUrl;

export const AUTH_CONFIG = {
  authorizeUrl: `${baseUrl}/oauth/authorize`,
  tokenUrl: `${baseUrl}/oauth/token`,
  userInfoUrl: `${functionsBaseUrl}/auth-user`,
  clientId: "doculigent-desktop",
  scope: "openid profile email offline_access",
  loopbackHost: "127.0.0.1",
  loopbackPath: "/callback",
} as const;

export const GOOGLE_DRIVE_CLIENT_ID = import.meta.env.MAIN_VITE_GOOGLE_DRIVE_CLIENT_ID ?? "";
export const GOOGLE_DRIVE_CLIENT_SECRET = import.meta.env.MAIN_VITE_GOOGLE_DRIVE_CLIENT_SECRET ?? "";
export const GOOGLE_DRIVE_CONFIGURED = Boolean(GOOGLE_DRIVE_CLIENT_ID && GOOGLE_DRIVE_CLIENT_SECRET);

export const GOOGLE_DRIVE_AUTH_CONFIG = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  clientId: GOOGLE_DRIVE_CLIENT_ID,
  clientSecret: GOOGLE_DRIVE_CLIENT_SECRET,
  scope: "https://www.googleapis.com/auth/drive.file email",
  loopbackHost: "127.0.0.1",
  loopbackPath: "/google-callback",
} as const;
