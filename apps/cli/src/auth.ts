import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { platform } from "node:os";

export interface AuthResult {
  token: string;
  email?: string;
  plan?: string;
}

export function authBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.DXXPCODE_AUTH_URL ?? "https://dxxpcode.dev";
}

export function billingUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${authBase(env)}/billing`;
}

/** Best-effort browser open; returns false when no opener exists (headless/SSH). */
export function openUrl(url: string): boolean {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const HTML_OK =
  "<!doctype html><title>dxxpcode</title><body style=\"font-family:ui-monospace,monospace;display:grid;place-items:center;min-height:100vh\">Signed in — you can close this tab.</body>";

/**
 * Localhost-callback login: binds a random port, the auth server redirects to
 *  http://127.0.0.1:<port>/callback?token=…&email=…&plan=…
 * after the browser sign-in completes. Rejects after `timeoutMs` (default 2 min).
 */
export function waitForLoginCallback(
  env: NodeJS.ProcessEnv = process.env,
  opts: { timeoutMs?: number } = {},
): { url: Promise<string>; result: Promise<AuthResult>; close: () => void } {
  const state = randomBytes(8).toString("hex");
  let server: Server;
  let resolveResult: (r: AuthResult) => void;
  let rejectResult: (e: Error) => void;
  const result = new Promise<AuthResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    if (u.searchParams.get("state") !== state) {
      res.writeHead(400).end("state mismatch");
      return;
    }
    const token = u.searchParams.get("token");
    if (!token) {
      res.writeHead(400).end("missing token");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(HTML_OK);
    server.close();
    resolveResult({
      token,
      email: u.searchParams.get("email") ?? undefined,
      plan: u.searchParams.get("plan") ?? undefined,
    });
  });
  const url = new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      const { port } = server.address() as { port: number };
      const redirect = encodeURIComponent(`http://127.0.0.1:${port}/callback`);
      resolve(`${authBase(env)}/connect?redirect=${redirect}&state=${state}`);
    });
  });
  server.listen(0, "127.0.0.1");

  const timer = setTimeout(() => {
    server.close();
    rejectResult(new Error("login timed out — no callback received"));
  }, opts.timeoutMs ?? 120_000);
  result.finally(() => clearTimeout(timer)).catch(() => {});

  return { url, result, close: () => server.close() };
}
