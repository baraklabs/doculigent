import { BrowserWindow, shell } from "electron";
import path from "node:path";
import { Channels } from "@shared/constants/channels";

export function toggleMaximize(win: BrowserWindow): boolean {
  if (win.isMaximized()) {
    win.unmaximize();
    return false;
  }
  win.maximize();
  return true;
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 580,
    minWidth: 860,
    minHeight: 520,
    resizable: true,
    maximizable: true,
    frame: false,
    title: "Doculigent",
    icon: path.join(__dirname, "../../resources/icon.ico"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("maximize", () => win.webContents.send(Channels.window.maximizeChanged, true));
  win.on("unmaximize", () => win.webContents.send(Channels.window.maximizeChanged, false));

  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "F11") return;
    event.preventDefault();
    toggleMaximize(win);
  });

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  return win;
}
