/** Electron shell entry point — kept thin per prompt.md: app lifecycle + window +
 *  IPC registration only. All business logic lives in the renderer's services/. */
import { app, BrowserWindow, Menu } from "electron";
import { createMainWindow } from "./window";
import { closeAnnotationOverlay } from "./annotationWindow";
import { registerIpcHandlers } from "./ipc";
import { registerMediaScheme, registerMediaHandler } from "./mediaProtocol";
import { restorePendingCursorOverride, restoreCursor } from "./native/systemCursor";
import { killPendingFfmpegJobs } from "./native/ffmpeg";
import { initTranscriptionWorkerClient, terminateTranscriptionWorker } from "./transcription/whisperWorkerClient";
import { registerProtocolClient, handleOpenUrl, handleSecondInstanceArgv, handleInitialArgv } from "./auth/deepLink";

// Must be called before the 'ready' event fires.
registerMediaScheme();

// __dirname here is this file's own compiled location (out/main/index.js) — the one path
// Rollup can never relocate, since this file is the entry chunk itself. See
// whisperWorkerClient.ts for why that matters (locating transcriptionWorker.js reliably).
initTranscriptionWorkerClient(__dirname);

// A doculigent://callback click (see auth/deepLink.ts) launches a *second* OS process on
// Windows/Linux while the app is already running. Without a single-instance lock that
// would open a second window instead of completing the sign-in the first window started;
// this hands the second launch's argv to the 'second-instance' handler below and lets the
// second process exit immediately.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => handleSecondInstanceArgv(argv));

  // macOS delivers doculigent:// URLs via this event instead of argv/second-instance.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleOpenUrl(url);
  });

  // The annotation overlay (a transparent draw window; its toolbar controls live inline
  // in RecordPage, not a second window) is deliberately independent of the main window
  // while open — closing it shouldn't be tied to navigating away from the Record tab. But
  // it must NOT outlive the main window: without this, closing the main window while the
  // overlay is open would leave the draw window as the only one left, so
  // 'window-all-closed' below would never fire and the app would keep running invisibly.
  const openMainWindow = (): void => {
    const win = createMainWindow();
    win.on("closed", () => closeAnnotationOverlay());
  };

  app.whenReady().then(() => {
    // No File/Edit/View/Window/Help menu bar — this isn't a document-editing app and the
    // default Electron menu doesn't do anything useful for it (matches the original
    // Tauri app, which had no native menu bar at all).
    Menu.setApplicationMenu(null);

    registerProtocolClient();

    // Cleans up a system cursor override left behind if the previous session crashed
    // mid-recording instead of reaching RecordingService.stop()'s normal restore.
    restorePendingCursorOverride();

    registerMediaHandler();
    registerIpcHandlers();
    openMainWindow();

    // Cold start via doculigent://callback (app wasn't already running) — rare for the
    // login flow specifically, but handled for completeness. See deepLink.ts.
    handleInitialArgv(process.argv);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Belt-and-suspenders alongside restorePendingCursorOverride() above: puts the cursor
  // back immediately on a graceful quit, rather than waiting for the next launch. Also
  // closes the annotation overlay, which can otherwise outlive the main window on macOS
  // (window-all-closed doesn't quit there — see openMainWindow's 'closed' handler, which
  // only covers that platform's non-quitting-on-close path indirectly via this).
  app.on("before-quit", () => {
    restoreCursor();
    closeAnnotationOverlay();
    // Any recording still transcoding in the background (see recording.ts) would never
    // get inserted into the library anyway once this process exits — no point letting an
    // orphaned ffmpeg process keep burning CPU after the app's gone.
    killPendingFfmpegJobs();
    // Same reasoning for the transcription UtilityProcess — no point leaving a loaded
    // ONNX model in memory in an orphaned child process once the app itself is gone.
    terminateTranscriptionWorker();
  });
}
