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
import { startProjectManagerScheduler } from "./projectManagers/scheduler";

if (process.platform === "win32") {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
}

// The main window is deliberately hidden for the whole duration of a recording (see
// hideMainWindowForDock, called as soon as the recording dock opens) — but its renderer is
// still doing real work the entire time: RecordingService's camera side-clip is a live
// canvas fed by a requestAnimationFrame loop (see sideTick), and a MediaRecorder pulling
// frames from it. `backgroundThrottling: false` on the window itself (window.ts) only
// disables Chromium's own timer/rAF throttling for a hidden *window* — it doesn't stop the
// OS/Chromium from deprioritizing the *renderer process's* scheduling once nothing is
// visibly showing it, which can still starve that rAF loop over a long-enough hidden
// stretch (most visibly on macOS). Without this, the canvas silently stops getting new
// frames well before the MediaRecorder (and the still-live audio track) actually stop,
// producing a camera.mp4 with a frozen video tail and continuing audio.
app.commandLine.appendSwitch("disable-renderer-backgrounding");

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
    startProjectManagerScheduler();
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
