/** BrowserWindow factory — 1100x580 min 860x520, fixed/non-maximizable, matching
 *  FUNCTIONALITY.md §15 (ported from the original Tauri window config).
 *  Frameless: the custom in-app topbar (src/app/layout/Layout.tsx) is the title bar —
 *  a native OS title bar would just duplicate the "Doculigent" branding shown there. */
import { BrowserWindow, shell } from "electron";
import path from "node:path";

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 580,
    minWidth: 860,
    minHeight: 520,
    resizable: false,
    maximizable: false,
    frame: false,
    title: "Doculigent",
    // Only meaningfully affects dev-mode (Linux/Windows taskbar) — packaged Windows/macOS
    // builds use the icon baked into the installer via electron-builder.yml's
    // `buildResources: resources` convention (resources/icon.ico / icon.icns), not this.
    icon: path.join(__dirname, "../../resources/icon.ico"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Anything that would open a new window (e.g. a target=_blank link) opens in the
  // OS default browser instead of a second Electron window.
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // electron-vite sets ELECTRON_RENDERER_URL during `electron-vite dev` (Vite dev
  // server); the packaged app has no such server and loads the built renderer file.
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return win;
}
