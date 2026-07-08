import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ServiceConfig } from "./config.js";
import type { SyncService } from "./service.js";
import { controlPanelHtml } from "./webui.js";

/**
 * Minimal HTTP control/status surface (no framework):
 *   GET  /health           liveness
 *   GET  /status           current service state
 *   POST /sync             trigger an immediate sync           (protected)
 *   POST /auth/send-code   send the Jupiter login OTP          (protected)
 *   POST /auth/verify      { code } complete login             (protected)
 *
 * Mutating routes require `Authorization: Bearer <SERVICE_TOKEN>` when a
 * serviceToken is configured.
 */
export function createControlServer(service: SyncService, config: ServiceConfig): Server {
  const authed = (req: IncomingMessage): boolean => {
    if (!config.serviceToken) return true;
    return req.headers.authorization === `Bearer ${config.serviceToken}`;
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  };

  return createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const path = (req.url ?? "/").split("?")[0];

      try {
        if (method === "GET" && (path === "/" || path === "/index.html")) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(controlPanelHtml());
        }
        if (method === "GET" && path === "/health") return json(res, 200, { ok: true });
        if (method === "GET" && path === "/status") return json(res, 200, service.getState());

        // ── mutating routes below ──
        if (method === "POST" && (path === "/sync" || path.startsWith("/auth/"))) {
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });

          if (path === "/sync") {
            void service.runSync();
            return json(res, 202, { accepted: true });
          }
          if (path === "/auth/send-code") {
            await service.sendCode();
            return json(res, 200, { sent: true });
          }
          if (path === "/auth/verify") {
            const body = (await readBody(req)) as { code?: string };
            if (!body.code) return json(res, 400, { error: "missing code" });
            await service.verifyCode(String(body.code));
            return json(res, 200, { authenticated: true });
          }
          if (path === "/auth/zenmoney") {
            const body = (await readBody(req)) as { token?: string };
            if (!body.token) return json(res, 400, { error: "missing token" });
            service.setZenToken(String(body.token));
            return json(res, 200, { zenConnected: true });
          }
        }

        json(res, 404, { error: "not found" });
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });
}
