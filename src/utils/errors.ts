/** Strips Electron's IPC rejection boilerplate off an error before it's shown to a user —
 *  `ipcRenderer.invoke` rejections come back as
 *  `Error invoking remote method '<channel>': <original error's own toString()>`, which
 *  itself is usually `<ErrorName>: <message>` (e.g. "TypeError: fetch failed" for a raw
 *  network failure that was never given a friendlier message at the throw site). Peels off
 *  both wrapper layers so only the actual message is left; falls back to a generic line if
 *  nothing useful survives (e.g. a bare "TypeError" with no message). */
export function friendlyErrorMessage(e: unknown): string {
  let msg = e instanceof Error ? e.message : String(e);
  msg = msg.replace(/^Error invoking remote method '[^']*':\s*/, "");
  // Can be doubled up (the IPC wrapper's own "Error: " plus the original error's own
  // "<Name>Error: " prefix once serialized) — strip up to two layers.
  for (let i = 0; i < 2; i++) {
    msg = msg.replace(/^[A-Za-z]*Error:\s*/, "");
  }
  return msg.trim() || "Something went wrong. Please try again.";
}
