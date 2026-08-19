
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

// Diagnostic log for native-capture backend selection (see screenCapture.ts) — written to
// disk rather than just console.log/error because on macOS a packaged app launched from
// Finder has no attached terminal to read those from, so this is the only way to inspect
// after the fact whether the ScreenCaptureKit helper loaded or the avfoundation fallback
// was used. One file per calendar day so logs don't grow unbounded across app runs.
function logFilePath(): string {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  return path.join(dir, `native-${date}.log`);
}

export function logNative(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(logFilePath(), line);
  } catch {
    // Logging must never break capture itself.
  }
}
