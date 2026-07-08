import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { loadConfig, parseDuration } from "../src/service/config.js";
import { initialState } from "../src/service/state.js";
import { createControlServer } from "../src/service/server.js";
import type { SyncService } from "../src/service/service.js";
import type { ServiceConfig } from "../src/service/config.js";

describe("parseDuration", () => {
  it("parses units", () => {
    expect(parseDuration("30m", 0)).toBe(1_800_000);
    expect(parseDuration("6h", 0)).toBe(21_600_000);
    expect(parseDuration("1d", 0)).toBe(86_400_000);
    expect(parseDuration("500", 0)).toBe(500);
    expect(parseDuration(undefined, 42)).toBe(42);
    expect(parseDuration("garbage", 42)).toBe(42);
  });
});

describe("loadConfig", () => {
  it("requires JUP_EMAIL", () => {
    expect(() => loadConfig({})).toThrow(/JUP_EMAIL/);
  });
  it("requires ZEN_TOKEN unless dry run", () => {
    expect(() => loadConfig({ JUP_EMAIL: "a@b.c" } as any)).toThrow(/ZEN_TOKEN/);
    expect(loadConfig({ JUP_EMAIL: "a@b.c", DRY_RUN: "1" } as any).dryRun).toBe(true);
  });
  it("parses years and interval", () => {
    const c = loadConfig({ JUP_EMAIL: "a@b.c", ZEN_TOKEN: "t", SYNC_YEARS: "2025, 2026", SYNC_INTERVAL: "12h" } as any);
    expect(c.years).toEqual([2025, 2026]);
    expect(c.intervalMs).toBe(12 * 3_600_000);
    expect(c.zenToken).toBe("t");
  });
});

describe("control server", () => {
  let server: ReturnType<typeof createControlServer>;
  let base: string;
  const calls: string[] = [];
  const fakeService = {
    getState: () => ({ ...initialState(), status: "idle" }),
    runSync: async () => void calls.push("runSync"),
    sendCode: async () => void calls.push("sendCode"),
    verifyCode: async (code: string) => void calls.push("verify:" + code),
  } as unknown as SyncService;
  const config = { serviceToken: "secret" } as ServiceConfig;

  beforeAll(async () => {
    server = createControlServer(fakeService, config);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("GET /health", async () => {
    const r = await fetch(base + "/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it("GET /status returns state", async () => {
    const r = await fetch(base + "/status");
    expect(((await r.json()) as { status: string }).status).toBe("idle");
  });

  it("POST /sync requires the bearer token", async () => {
    const unauth = await fetch(base + "/sync", { method: "POST" });
    expect(unauth.status).toBe(401);
    const ok = await fetch(base + "/sync", { method: "POST", headers: { authorization: "Bearer secret" } });
    expect(ok.status).toBe(202);
    expect(calls).toContain("runSync");
  });

  it("POST /auth/verify needs a code", async () => {
    const bad = await fetch(base + "/auth/verify", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" });
    expect(bad.status).toBe(400);
    const ok = await fetch(base + "/auth/verify", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(ok.status).toBe(200);
    expect(calls).toContain("verify:123456");
  });

  it("unknown route → 404", async () => {
    expect((await fetch(base + "/nope")).status).toBe(404);
  });
});
