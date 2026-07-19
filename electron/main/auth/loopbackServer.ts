/** Local RFC 8252 loopback redirect target for the OAuth browser round-trip: doculigent.com
 *  redirects the system browser back to this ephemeral 127.0.0.1 port with `?code=&state=`. */
import http from "node:http";
import { AUTH_CONFIG } from "@shared/constants/authConfig";

export interface LoopbackResult {
  code: string;
  state: string;
}

export class LoopbackServer {
  private closed = false;
  private port = 0;
  private settle: { resolve: (r: LoopbackResult) => void; reject: (e: Error) => void } | null = null;

  private constructor(private readonly server: http.Server) {
    server.on("request", (req, res) => this.handleRequest(req, res));
  }

  static start(): Promise<LoopbackServer> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      const instance = new LoopbackServer(server);
      server.once("error", reject);
      server.listen(0, AUTH_CONFIG.loopbackHost, () => {
        server.removeListener("error", reject);
        const address = server.address();
        instance.port = typeof address === "object" && address ? address.port : 0;
        resolve(instance);
      });
    });
  }

  get redirectUri(): string {
    return `http://${AUTH_CONFIG.loopbackHost}:${this.port}${AUTH_CONFIG.loopbackPath}`;
  }

  /** Resolves once the redirect hits this server. Only meaningful to call once per instance. */
  waitForCallback(): Promise<LoopbackResult> {
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${AUTH_CONFIG.loopbackHost}:${this.port}`);
    if (url.pathname !== AUTH_CONFIG.loopbackPath) {
      res.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(resultPage(error));

    if (error) {
      this.settle?.reject(new Error(url.searchParams.get("error_description") ?? error));
    } else if (code && state) {
      this.settle?.resolve({ code, state });
    } else {
      this.settle?.reject(new Error("Callback was missing code/state"));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.close();
  }
}

function resultPage(error: string | null): string {
  const message = error
    ? "Sign-in failed. You can close this window and try again from Doculigent."
    : "Signed in — you can close this window and return to Doculigent.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Doculigent</title></head>` +
    `<body style="font-family: system-ui, sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; color:#1c1e2a;">` +
    `<p>${message}</p></body></html>`;
}
