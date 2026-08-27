
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

  private constructor(
    private readonly server: http.Server,
    private readonly host: string,
    private readonly path: string
  ) {
    server.on("request", (req, res) => this.handleRequest(req, res));
  }

  static start(path: string = AUTH_CONFIG.loopbackPath, host: string = AUTH_CONFIG.loopbackHost): Promise<LoopbackServer> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      const instance = new LoopbackServer(server, host, path);
      server.once("error", reject);
      server.listen(0, host, () => {
        server.removeListener("error", reject);
        const address = server.address();
        instance.port = typeof address === "object" && address ? address.port : 0;
        resolve(instance);
      });
    });
  }

  get redirectUri(): string {
    return `http://${this.host}:${this.port}${this.path}`;
  }

  waitForCallback(timeoutMs = 5 * 60 * 1000): Promise<LoopbackResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle = null;
        reject(new Error("Sign-in timed out. Please try again."));
      }, timeoutMs);

      this.settle = {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
    if (url.pathname !== this.path) {
      res.writeHead(404).end();
      return;
    }

    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(resultPage(error));

    const settle = this.settle;
    this.settle = null;

    if (error) {
      settle?.reject(new Error(url.searchParams.get("error_description") ?? error));
    } else if (code && state) {
      settle?.resolve({ code, state });
    } else {
      settle?.reject(new Error("Callback was missing code/state"));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.close();
  }

  cancel(reason: Error): void {
    const settle = this.settle;
    this.settle = null;
    settle?.reject(reason);
    this.close();
  }
}

function resultPage(error: string | null): string {
  const message = error
    ? "Sign-in failed. You can close this window and try again from Doculigent App"
    : "Signed in — you can close this window and return to Doculigent App";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Doculigent</title></head>` +
    `<body style="font-family: system-ui, sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; color:#1c1e2a;">` +
    `<p>${message}</p></body></html>`;
}
