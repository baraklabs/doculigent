/** doculigent://callback custom URI scheme (RFC 8252 §7.1) — a click-through alternative
 *  on doculigent.com's sign-in result page for browsers that refuse to fetch
 *  http://127.0.0.1 from an https page (increasingly common; see loopbackServer.ts for
 *  the primary redirect target). Registered with the OS via electron-builder.yml's
 *  `protocols` key (packaged builds) or setAsDefaultProtocolClient below (dev). Resolves
 *  into the same login race as the loopback server and manual code paste — see
 *  doculigentAuth.ts's `login()` and `handleDeepLinkCallback`. */
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { handleDeepLinkCallback } from "./doculigentAuth";

const PROTOCOL = "doculigent";

export function registerProtocolClient(): void {
  if (process.defaultApp) {
    // Running unpackaged under the `electron` launcher — the OS needs to be told to
    // re-invoke it with this project's entry script, not just bare `electron.exe`.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

function extractDeepLink(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
}

/** macOS: fired when the OS hands the already-running (or just-launched) app a
 *  doculigent:// URL — the platform never goes through argv/second-instance for this. */
export function handleOpenUrl(url: string): void {
  if (url.startsWith(`${PROTOCOL}://`)) handleDeepLinkCallback(url);
}

/** Windows/Linux: a doculigent:// click launches a *second* OS process while the app is
 *  already running; requestSingleInstanceLock's 'second-instance' handler (see
 *  electron/main/index.ts) redirects that second launch here instead of opening a second
 *  window, with the URL arriving in argv. */
export function handleSecondInstanceArgv(argv: string[]): void {
  const url = extractDeepLink(argv);
  if (url) handleDeepLinkCallback(url);

  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

/** Windows/Linux cold start via protocol (app wasn't already running): the URL is in this
 *  process's own launch argv instead. Rare for the login flow specifically (the app is
 *  normally already running when the user clicks back from the browser), but handled for
 *  completeness. */
export function handleInitialArgv(argv: string[]): void {
  const url = extractDeepLink(argv);
  if (url) handleDeepLinkCallback(url);
}
