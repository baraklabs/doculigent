
let accessToken: string | null = null;
let expiresAt: number | null = null;

export function setGoogleDriveAccessToken(token: string, expiresInSeconds?: number): void {
  accessToken = token;
  if (expiresInSeconds) {
    const safeLifetimeSeconds = Math.max(0, expiresInSeconds - 60);
    expiresAt = Date.now() + safeLifetimeSeconds * 1000;
  } else {
    expiresAt = null;
  }
}

export function getGoogleDriveAccessToken(): string | null {
  if (expiresAt !== null && Date.now() >= expiresAt) {
    accessToken = null;
    expiresAt = null;
  }
  return accessToken;
}

export function hasLiveGoogleDriveAccessToken(): boolean {
  return getGoogleDriveAccessToken() !== null;
}

export function clearGoogleDriveAccessToken(): void {
  accessToken = null;
  expiresAt = null;
}
