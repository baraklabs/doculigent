
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { handleDeepLinkCallback } from "./doculigentAuth";

const PROTOCOL = "doculigent";

export function registerProtocolClient(): void {
  if (process.defaultApp) {
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

export function handleOpenUrl(url: string): void {
  if (url.startsWith(`${PROTOCOL}://`)) handleDeepLinkCallback(url);
}

export function handleSecondInstanceArgv(argv: string[]): void {
  const url = extractDeepLink(argv);
  if (url) handleDeepLinkCallback(url);

  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

export function handleInitialArgv(argv: string[]): void {
  const url = extractDeepLink(argv);
  if (url) handleDeepLinkCallback(url);
}
