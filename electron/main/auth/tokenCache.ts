
let accessToken: string | null = null;
let expiresAt: string | null = null;

export function setAccessToken(token: string, expiry: string | null): void {
  accessToken = token;
  expiresAt = expiry;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function clearAccessToken(): void {
  accessToken = null;
  expiresAt = null;
}
