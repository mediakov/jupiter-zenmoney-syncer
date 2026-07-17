import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ServiceConfig } from "./config.js";
import type { SyncService } from "./service.js";
import type { ProviderId } from "./providers.js";
import { controlPanelHtml } from "./webui.js";

/**
 * Minimal HTTP control/status surface (no framework):
 *   GET  /health                       liveness
 *   GET  /status                       current service state
 *   POST /sync                         trigger an immediate sync              (protected)
 *   POST /auth/<card>/send-code        { email? } set email + send OTP        (protected)
 *   POST /auth/<card>/verify           { code } complete that card's login    (protected)
 *   POST /auth/zenmoney                { token }                              (protected)
 *
 * `<card>` is a provider id: `jupiter` or `plasma`. Each card logs in separately — one
 * card needing an OTP does not stop the other from syncing.
 *
 * `/auth/send-code` and `/auth/verify` remain as aliases for `jupiter`, so anything
 * already pointed at them keeps working.
 *
 * Mutating routes require `Authorization: Bearer <SERVICE_TOKEN>` when a
 * serviceToken is configured.
 */
/**
 * `/auth/plasma/verify` → { provider: "plasma", action: "verify" }.
 * `/auth/verify`        → { provider: "jupiter", … } — the pre-multi-card path, kept
 * working rather than 404-ing whatever is already calling it.
 * `/auth/zenmoney` is NOT an auth route in this sense; it is handled separately.
 */
function parseAuthRoute(path: string): { provider: ProviderId; action: "send-code" | "verify" } | null {
  const m = /^\/auth\/(?:(jupiter|plasma)\/)?(send-code|verify)$/.exec(path);
  return m ? { provider: (m[1] as ProviderId) ?? "jupiter", action: m[2] as "send-code" | "verify" } : null;
}

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
        if (method === "GET" && path === "/last-sync") {
          // contains account/transaction data — guard it when a token is configured
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });
          return json(res, 200, service.getLastDetail() ?? { empty: true });
        }

        // ── mutating routes below ──
        if (method === "POST" && (path === "/sync" || path.startsWith("/auth/"))) {
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });

          if (path === "/sync") {
            void service.runSync();
            return json(res, 202, { accepted: true });
          }
          // /auth/<card>/send-code | /auth/<card>/verify, with the bare paths kept as
          // Jupiter aliases so existing callers/scripts do not break.
          const authRoute = parseAuthRoute(path);
          if (authRoute) {
            const { provider, action } = authRoute;
            const state = service.getState().providers.find((p) => p.id === provider);
            if (!state) return json(res, 404, { error: `unknown card "${provider}"` });

            if (action === "send-code") {
              const body = (await readBody(req)) as { email?: string };
              if (body.email != null) {
                const email = String(body.email).trim();
                if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "invalid email" });
                service.setEmail(provider, email);
              }
              if (!service.getState().providers.find((p) => p.id === provider)?.email) {
                return json(res, 400, { error: `no ${state.label} email set` });
              }
              await service.sendCode(provider);
              return json(res, 200, { sent: true, provider });
            }
            const body = (await readBody(req)) as { code?: string };
            if (!body.code) return json(res, 400, { error: "missing code" });
            await service.verifyCode(provider, String(body.code));
            return json(res, 200, { authenticated: true, provider });
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
