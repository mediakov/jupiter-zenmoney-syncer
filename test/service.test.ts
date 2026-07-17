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
  it("JUP_EMAIL is optional (can be provided later via UI)", () => {
    expect(loadConfig({} as any).jupiterEmail).toBeNull();
    expect(loadConfig({ JUP_EMAIL: "a@b.c" } as any).jupiterEmail).toBe("a@b.c");
  });
  it("ZEN_TOKEN is optional (can be provided later via UI)", () => {
    const c = loadConfig({ JUP_EMAIL: "a@b.c" } as any);
    expect(c.zenToken).toBeNull();
    expect(loadConfig({ JUP_EMAIL: "a@b.c", ZEN_TOKEN: "t" } as any).zenToken).toBe("t");
  });
  it("PLASMA_EMAIL is optional, and gets its own session file", () => {
    // Separate file on purpose: separate login, separate tokens. Sharing one would have
    // each card's login clobber the other's session.
    const none = loadConfig({});
    expect(none.plasmaEmail).toBeNull();
    expect(none.plasmaSessionFile).not.toBe(none.sessionFile);

    const both = loadConfig({ JUP_EMAIL: "j@x.com", PLASMA_EMAIL: "p@x.com", PLASMA_SESSION_FILE: "/data/p.json" });
    expect(both.jupiterEmail).toBe("j@x.com");
    expect(both.plasmaEmail).toBe("p@x.com");
    expect(both.plasmaSessionFile).toBe("/data/p.json");
  });

  it("running one card without the other is a supported configuration", () => {
    expect(loadConfig({ PLASMA_EMAIL: "p@x.com" }).jupiterEmail).toBeNull();
    expect(loadConfig({ JUP_EMAIL: "j@x.com" }).plasmaEmail).toBeNull();
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
  const emails: Record<string, string | null> = { jupiter: null, plasma: null };
  const fakeService = {
    getState: () => ({
      ...initialState([
        { id: "jupiter", label: "Jupiter", email: emails.jupiter, authenticated: false },
        { id: "plasma", label: "Plasma One", email: emails.plasma, authenticated: false },
      ]),
      status: "idle",
    }),
    runSync: async () => void calls.push("runSync"),
    sendCode: async (id: string) => void calls.push("sendCode:" + id),
    verifyCode: async (id: string, code: string) => void calls.push("verify:" + id + ":" + code),
    setEmail: (id: string, email: string) => {
      emails[id] = email;
      calls.push("email:" + id + ":" + email);
    },
    setZenToken: (token: string) => void calls.push("zen:" + token),
    getLastDetail: () => null,
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

  const post = (path: string, body?: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: body === undefined ? "{}" : JSON.stringify(body),
    });

  it("POST /auth/<card>/send-code sets that card's email, then sends", async () => {
    const noEmail = await post("/auth/plasma/send-code");
    expect(noEmail.status).toBe(400); // no email set for that card yet
    expect(((await noEmail.json()) as { error: string }).error).toContain("Plasma One"); // names the right card

    expect((await post("/auth/plasma/send-code", { email: "not-an-email" })).status).toBe(400);

    const ok = await post("/auth/plasma/send-code", { email: "me@plasma.com" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ sent: true, provider: "plasma" });
    expect(calls).toContain("email:plasma:me@plasma.com");
    expect(calls).toContain("sendCode:plasma");
  });

  it("routes each card independently — one login does not touch the other", async () => {
    await post("/auth/jupiter/send-code", { email: "me@jup.com" });
    expect(calls).toContain("email:jupiter:me@jup.com");
    expect(calls).toContain("sendCode:jupiter");
    // The plasma email set by the previous test is untouched.
    expect(emails.plasma).toBe("me@plasma.com");
    expect(emails.jupiter).toBe("me@jup.com");
  });

  it("POST /auth/<card>/verify needs a code, and verifies that card", async () => {
    expect((await post("/auth/plasma/verify")).status).toBe(400);
    const ok = await post("/auth/plasma/verify", { code: "123456" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ authenticated: true, provider: "plasma" });
    expect(calls).toContain("verify:plasma:123456");
  });

  it("keeps the bare /auth/* paths working as Jupiter aliases", async () => {
    // Anything already pointed at the pre-multi-card API must not break.
    const ok = await post("/auth/verify", { code: "999" });
    expect(ok.status).toBe(200);
    expect(calls).toContain("verify:jupiter:999");
    await post("/auth/send-code", { email: "legacy@jup.com" });
    expect(calls).toContain("email:jupiter:legacy@jup.com");
  });

  it("404s an unknown card rather than guessing which one was meant", async () => {
    expect((await post("/auth/monzo/verify", { code: "1" })).status).toBe(404);
  });

  it("GET / serves the HTML control panel", async () => {
    const r = await fetch(base + "/");
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("Jupiter");
    expect(html).toContain("ZenMoney");
  });

  it("POST /auth/zenmoney stores the token", async () => {
    const bad = await fetch(base + "/auth/zenmoney", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" });
    expect(bad.status).toBe(400);
    const ok = await fetch(base + "/auth/zenmoney", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ token: "zen_abc" }),
    });
    expect(ok.status).toBe(200);
    expect(calls).toContain("zen:zen_abc");
  });

  it("GET /last-sync is guarded and returns empty when no sync yet", async () => {
    const noAuth = await fetch(base + "/last-sync");
    expect(noAuth.status).toBe(401);
    const ok = await fetch(base + "/last-sync", { headers: { authorization: "Bearer secret" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ empty: true });
  });

  it("unknown route → 404", async () => {
    expect((await fetch(base + "/nope")).status).toBe(404);
  });
});
