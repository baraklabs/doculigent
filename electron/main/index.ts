import { app, BrowserWindow, globalShortcut, Menu } from "electron";
import path from "node:path";
import { createMainWindow } from "./window";
import { closeAnnotationOverlay, setMainWindowForAnnotation } from "./annotationWindow";
import { closeCameraBubbleWindow } from "./cameraBubbleWindow";
import { closeRecordingDockWindow, setMainWindowForRecordingDock } from "./recordingDockWindow";
import { closeAreaSelectOverlay } from "./areaSelectWindow";
import { closeCountdownWindow } from "./countdownWindow";
import { registerIpcHandlers } from "./ipc";
import { clearAnnotationsGlobal, toggleAnnotationOverlay } from "./ipc/annotation";
import { registerMediaScheme, registerMediaHandler } from "./mediaProtocol";
import { registerDisplayMediaHandler } from "./displayMedia";
import { killPendingFfmpegJobs } from "./native/ffmpeg";
import { killPendingScreenCapture } from "./native/screenCapture";
import { initTranscriptionWorkerClient, terminateTranscriptionWorker } from "./transcription/whisperWorkerClient";
import { registerProtocolClient, handleOpenUrl, handleSecondInstanceArgv, handleInitialArgv } from "./auth/deepLink";

if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

// The macOS counterpart to the Windows switch above, and the same failure it prevents:
// Chromium suspends painting for a window it believes is fully occluded, so the window
// keeps presenting a stale frame while its renderer goes on running normally — input is
// delivered, handlers fire, React commits, nothing appears. It reads as a frozen UI rather
// than a rendering fault, which is what made this look like blocked tab navigation.
//
// Why it tracked Screen Recording permission: macOS derives NSWindowOcclusionState from
// window-server visibility information that permission gates. Without it the app gets
// degraded occlusion reporting, Chromium concludes the window is hidden, and stops drawing
// — hence "works in dev, freezes in the downloaded DMG", where dev already held the grant
// and the packaged build (a separate code-signing identity, so a separate TCC subject)
// did not.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("disable-features", "MacWebContentsOcclusion");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
}

function buildDarwinMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "Doculigent",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    // Kept in production builds, not just dev: replacing the default application menu also
    // removes the default Cmd+Opt+I accelerator, which left packaged builds with no way to
    // open DevTools at all — so a bug that only reproduces in a signed/packaged app (where
    // TCC treats it as a different identity than a locally-built one) had no console to
    // read.
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
    },
  ]);
}

registerMediaScheme();

initTranscriptionWorkerClient(__dirname);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => handleSecondInstanceArgv(argv));

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleOpenUrl(url);
  });

  const openMainWindow = (): void => {
    const win = createMainWindow();
    setMainWindowForAnnotation(win);
    setMainWindowForRecordingDock(win);
    win.on("closed", () => {
      closeAnnotationOverlay();
      closeCameraBubbleWindow();
      closeRecordingDockWindow();
      closeAreaSelectOverlay();
      closeCountdownWindow();
    });
  };

  app.whenReady().then(() => {
    if (process.platform === "darwin" && !app.isPackaged) {
      app.dock?.setIcon(path.join(__dirname, "../../resources/icon.png"));
    }

    Menu.setApplicationMenu(process.platform === "darwin" ? buildDarwinMenu() : null);

    registerProtocolClient();

    registerMediaHandler();
    registerDisplayMediaHandler();
    registerIpcHandlers();
    openMainWindow();

    if (!globalShortcut.register("CommandOrControl+Shift+A", toggleAnnotationOverlay)) {
      console.error("Couldn't register Ctrl+Shift+A (hide/show annotation overlay) — already in use");
    }
    if (!globalShortcut.register("CommandOrControl+Shift+X", clearAnnotationsGlobal)) {
      console.error("Couldn't register Ctrl+Shift+X (clear annotations) — already in use");
    }

    handleInitialArgv(process.argv);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    globalShortcut.unregisterAll();
    closeAnnotationOverlay();
    closeCameraBubbleWindow();
    closeRecordingDockWindow();
    closeAreaSelectOverlay();
    closeCountdownWindow();
    killPendingFfmpegJobs();
    killPendingScreenCapture();
    terminateTranscriptionWorker();
  });
}
