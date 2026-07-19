/**
 * Error convention carried over from FUNCTIONALITY.md's "Error handling convention":
 * a plain readable message, not a structured code. `ipcMain.handle` rejections
 * serialize whatever `Error` is thrown into a renderer-side rejection whose `message`
 * is this string — the renderer's `catch (e) { setError(String(e)) }` pattern just works.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented yet: ${what}`);
    this.name = "NotImplementedError";
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`not found: ${what}`);
    this.name = "NotFoundError";
  }
}
