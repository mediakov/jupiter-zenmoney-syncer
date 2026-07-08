import { JupiterCard } from "jupiter-card-sdk";
import { toScrapeResult } from "../convert.js";
import { scrapeToDiff } from "../toDiff.js";
import { ZenMoneyClient } from "../zenClient.js";
import type { ServiceConfig } from "./config.js";
import { initialState, type ServiceState } from "./state.js";

type Logger = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;

/**
 * The long-running syncer: a periodic loop that reads Jupiter and pushes to
 * ZenMoney, plus headless auth bootstrap. Errors in one run never crash the
 * service — they're recorded in state and the loop continues.
 */
export class SyncService {
  private readonly jupiter: JupiterCard;
  private readonly zen: ZenMoneyClient | null;
  private readonly state: ServiceState = initialState();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ServiceConfig,
    private readonly log: Logger = () => {},
  ) {
    this.jupiter = new JupiterCard({
      auth: { kind: "email", email: config.jupiterEmail, sessionFile: config.sessionFile },
    });
    this.zen = config.zenToken ? new ZenMoneyClient({ token: config.zenToken }) : null;
    this.state.authenticated = this.jupiter.isAuthenticated();
    this.state.status = this.state.authenticated ? "idle" : "needs-auth";
  }

  getState(): Readonly<ServiceState> {
    return this.state;
  }

  /** Begin the schedule; runs an initial sync if already authenticated. */
  start(): void {
    this.log("info", `service started; interval ${this.config.intervalMs}ms, years ${this.config.years.join(",")}`);
    const tick = () => {
      this.state.nextSyncAt = new Date(Date.now() + this.config.intervalMs).toISOString();
      void this.runSync();
    };
    this.timer = setInterval(tick, this.config.intervalMs);
    if (this.jupiter.isAuthenticated()) tick();
    else this.log("warn", "not authenticated — call POST /auth/send-code then /auth/verify");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Send the Jupiter login OTP to the configured email. */
  async sendCode(): Promise<void> {
    await this.jupiter.login.sendCode();
    this.log("info", "OTP sent to Jupiter email");
  }

  /** Complete Jupiter login with the emailed code, then kick off a sync. */
  async verifyCode(code: string): Promise<void> {
    await this.jupiter.login.verify(code);
    this.state.authenticated = true;
    this.state.status = "idle";
    this.log("info", "authenticated");
    void this.runSync();
  }

  /** Run one sync across all configured years. Safe to call concurrently (guarded). */
  async runSync(): Promise<void> {
    if (this.running) return;
    if (!this.jupiter.isAuthenticated()) {
      this.state.status = "needs-auth";
      this.state.authenticated = false;
      return;
    }
    this.running = true;
    this.state.status = "syncing";
    try {
      const [cards, balance] = await Promise.all([this.jupiter.cards.list(), this.jupiter.cards.balance()]);
      const txs = [];
      for (const year of this.config.years) txs.push(...(await this.jupiter.transactions.all({ year })));
      const scrape = toScrapeResult(cards, balance, txs);

      let pushed = false;
      if (this.zen && !this.config.dryRun) {
        const { map, serverTimestamp } = await this.zen.instruments();
        const diff = scrapeToDiff(scrape, map);
        await this.zen.push(diff.accounts, diff.transactions, serverTimestamp);
        pushed = true;
      }

      this.state.lastResult = { accounts: scrape.accounts.length, transactions: scrape.transactions.length, pushed };
      this.state.lastSyncOk = true;
      this.state.lastError = null;
      this.state.syncCount += 1;
      this.log("info", `sync ok: ${scrape.transactions.length} tx, pushed=${pushed}`);
    } catch (e) {
      this.state.lastSyncOk = false;
      this.state.lastError = e instanceof Error ? e.message : String(e);
      this.log("error", `sync failed: ${this.state.lastError}`);
      // if the Jupiter session died beyond refresh, surface it for re-auth
      if (!this.jupiter.isAuthenticated()) {
        this.state.authenticated = false;
        this.state.status = "needs-auth";
      }
    } finally {
      this.running = false;
      this.state.lastSyncAt = new Date().toISOString();
      if (this.state.status === "syncing") this.state.status = this.state.lastSyncOk ? "idle" : "error";
    }
  }
}
