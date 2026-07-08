#!/usr/bin/env -S npx tsx
/**
 * Long-running Jupiter → ZenMoney sync service.
 *
 * Env:
 *   JUP_EMAIL       (optional)  Jupiter account email; can be set later via the UI/API
 *   ZEN_TOKEN       (required unless DRY_RUN=1)  ZenMoney API token
 *   SYNC_INTERVAL   default 6h  e.g. "30m", "6h", "1d"
 *   SYNC_YEARS      default current year, e.g. "2025,2026"
 *   SESSION_FILE    default /data/.jup-session.json
 *   DRY_RUN         "1" to read+convert without pushing
 *   PORT            default 8080
 *   SERVICE_TOKEN   optional bearer token protecting POST routes
 *
 * First run needs the email + a one-time OTP:
 *   curl -XPOST localhost:8080/auth/send-code -d '{"email":"you@example.com"}'
 *   curl -XPOST localhost:8080/auth/verify -d '{"code":"123456"}'
 * After that the saved session auto-refreshes and it runs unattended.
 */
import { loadConfig } from "./config.js";
import { SyncService } from "./service.js";
import { createControlServer } from "./server.js";

const log = (level: string, msg: string, extra?: unknown) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) }));

const config = loadConfig();
const service = new SyncService(config, (l, m, e) => log(l, m, e));
service.start();

const server = createControlServer(service, config);
server.listen(config.port, () =>
  log("info", `control panel: open http://localhost:${config.port} to connect Jupiter + ZenMoney`),
);

const shutdown = (sig: string) => {
  log("info", `received ${sig}, shutting down`);
  service.stop();
  server.close(() => process.exit(0));
  // force-exit if close hangs
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
