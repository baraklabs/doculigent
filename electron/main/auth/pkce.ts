/** RFC 7636 PKCE helpers, plus the OAuth `state` nonce used to bind the callback to the
 *  request that started it. */
import crypto from "node:crypto";

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes -> 43-character base64url string, within RFC 7636's 43-128 char range. */
export function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

export function deriveCodeChallenge(verifier: string): string {
  return base64url(crypto.createHash("sha256").update(verifier).digest());
}

export function generateState(): string {
  return base64url(crypto.randomBytes(16));
}
