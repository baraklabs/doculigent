// frameDimensions/toFrameCoords are used independently by resolveCameraBubbleTrack and
// editProjectStore.ts (Advanced mode's editable overlay). The synthetic cursor-overlay
// pass that used to live in this file (overlayCursorTrack/loadCursorIcons) was a Quick
// Recording-only stopgap for gdigrab's flickering native cursor draw — superseded by
// native compositor-drawn capture (Windows.Graphics.Capture / ScreenCaptureKit, see
// electron/main/native/screenCapture.ts), so it's been removed rather than left dead.
export { frameDimensions, toFrameCoords } from "@shared/lib/cursorFrame";
