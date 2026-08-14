import { app, BrowserWindow, Menu } from "electron";
import path from "node:path";
import { createMainWindow } from "./window";
import { closeAnnotationOverlay, setMainWindowForAnnotation } from "./annotationWindow";
import { closeCameraBubbleWindow } from "./cameraBubbleWindow";
import { closeAreaSelectOverlay } from "./areaSelectWindow";
import { registerIpcHandlers } from "./ipc";
import { registerMediaScheme, registerMediaHandler } from "./mediaProtocol";
import { restorePendingCursorOverride, restoreCursor } from "./native/systemCursor";
import { killPendingFfmpegJobs } from "./native/ffmpeg";
import { killPendingScreenCapture } from "./native/screenCapture";
import { initTranscriptionWorkerClient, terminateTranscriptionWorker } from "./transcription/whisperWorkerClient";
import { registerProtocolClient, handleOpenUrl, handleSecondInstanceArgv, handleInitialArgv } from "./auth/deepLink";
import { startProjectManagerScheduler } from "./projectManagers/scheduler";

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
    win.on("closed", () => {
      closeAnnotationOverlay();
      closeCameraBubbleWindow();
      closeAreaSelectOverlay();
    });
  };

  app.whenReady().then(() => {
    if (process.platform === "darwin" && !app.isPackaged) {
      app.dock?.setIcon(path.join(__dirname, "../../resources/icon.png"));
    }

    Menu.setApplicationMenu(process.platform === "darwin" ? buildDarwinMenu() : null);

    registerProtocolClient();

    restorePendingCursorOverride();

    registerMediaHandler();
    registerIpcHandlers();
    startProjectManagerScheduler();
    openMainWindow();

    handleInitialArgv(process.argv);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    restoreCursor();
    closeAnnotationOverlay();
    closeCameraBubbleWindow();
    closeAreaSelectOverlay();
    killPendingFfmpegJobs();
    killPendingScreenCapture();
    terminateTranscriptionWorker();
  });
}
