
import { getValidAccessToken, refreshAccessToken } from "./tokenManager";

export class UnauthenticatedError extends Error {
  constructor(message = "Not signed in") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export async function authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let token = await getValidAccessToken();
  if (!token) throw new UnauthenticatedError();

  const withAuth = (bearer: string): RequestInit => ({
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${bearer}` },
  });

  let res = await fetch(url, withAuth(token));
  if (res.status === 401) {
    token = await refreshAccessToken();
    res = await fetch(url, withAuth(token));
  }
  return res;
}
