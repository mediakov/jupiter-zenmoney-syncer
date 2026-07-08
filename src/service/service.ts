import { JupiterCard } from "jupiter-card-sdk";
import { toScrapeResult } from "../convert.js";
import { scrapeToDiff } from "../toDiff.js";
import { ZenMoneyClient } from "../zenClient.js";
import { SolanaResolver } from "../solana.js";
import { SignatureCache, resolveDepositSources } from "../transfers.js";
import type { ServiceConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { initialState, type ServiceState, type SyncDetail } from "./state.js";

type Logger = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;

/**
 * The long-running syncer: a periodic loop that reads Jupiter and pushes to
 * ZenMoney, plus headless auth bootstrap. Errors in one run never crash the
 * service — they're recorded in state and the loop continues.
 */
export class SyncService {
  private readonly jupiter: JupiterCard;
  private readonly creds: CredentialStore;
  private readonly solana: SolanaResolver;
  private readonly sigCache: SignatureCache;
  private zen: ZenMoneyClient | null;
  private readonly state: ServiceState = initialState();
  private lastDetail: SyncDetail | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ServiceConfig,
    private readonly log: Logger = () => {},
  ) {
    this.jupiter = new JupiterCard({
      auth: { kind: "email", email: config.jupiterEmail, sessionFile: config.sessionFile },
    });
    this.creds = new CredentialStore(config.credFile);
    this.solana = new SolanaResolver({ rpc: config.solanaRpc });
    this.sigCache = new SignatureCache(config.sigCacheFile);
    // ZenMoney token: env takes precedence, else a previously UI-provided one.
    const token = config.zenToken ?? this.creds.zenToken ?? null;
    this.zen = token ? new ZenMoneyClient({ token }) : null;
    this.state.authenticated = this.jupiter.isAuthenticated();
    this.state.zenConnected = this.zen != null;
    this.state.status = this.state.authenticated ? "idle" : "needs-auth";
  }

  /** Store a ZenMoney API token (from the web UI/API) and start using it. */
  setZenToken(token: string): void {
    this.creds.setZenToken(token);
    this.zen = new ZenMoneyClient({ token });
    this.state.zenConnected = true;
    this.log("info", "ZenMoney token set");
  }

  getState(): Readonly<ServiceState> {
    return this.state;
  }

  /** Detail of the last sync: what we read from Jupiter and pushed to ZenMoney. */
  getLastDetail(): SyncDetail | null {
    return this.lastDetail;
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

  /**
   * Run one sync across all configured years. Safe to call concurrently (guarded).
   * @param reconcile one-off: force deposit→transfer conversions to override
   *   existing income records / deletion tombstones (see toDiff `reconcile`).
   */
  async runSync(reconcile = false): Promise<void> {
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

      // what we received from Jupiter (sample the most recent transactions)
      const jupiterDetail: SyncDetail["jupiter"] = {
        cards: cards.map((c) => ({ last4: c.last4, status: c.status })),
        balance: { currency: balance.currency, spendableBalance: balance.spendableBalance, withdrawableBalance: balance.withdrawableBalance },
        transactionCount: txs.length,
        transactions: [...txs]
          .sort((a, b) => (a.transactionTimestamp < b.transactionTimestamp ? 1 : -1))
          .slice(0, 20)
          .map((t) => ({
            id: t.id,
            date: t.transactionTimestamp,
            direction: t.direction,
            amount: t.settlementAmount,
            currency: t.settlementCurrency,
            merchant: t.card?.merchantName ?? null,
          })),
      };

      let pushed = false;
      let zenmoneyDetail: SyncDetail["zenmoney"];
      if (this.zen && !this.config.dryRun) {
        const { map, userId, serverTimestamp, accounts } = await this.zen.context();
        // trace deposit sources → map matching ones to transfers (else income)
        const transferSources = await resolveDepositSources(txs, {
          solana: this.solana,
          accounts,
          cache: this.sigCache,
          log: (m) => this.log("info", m),
        });
        const diff = scrapeToDiff(scrape, { instruments: map, userId, transferSources, reconcile });
        const resp = await this.zen.push(diff.accounts, diff.transactions, serverTimestamp, diff.deletions);
        pushed = true;
        zenmoneyDetail = {
          pushed: true,
          accounts: diff.accounts.length,
          transactions: diff.transactions.length,
          serverTimestamp: resp?.serverTimestamp ?? null,
          transactionsSample: diff.transactions.slice(0, 20).map((t) => ({
            id: t.id,
            date: t.date,
            income: t.income,
            outcome: t.outcome,
            payee: t.payee,
          })),
        };
      } else {
        zenmoneyDetail = { pushed: false, reason: this.config.dryRun ? "dry-run" : "no ZenMoney token" };
      }

      this.lastDetail = { at: new Date().toISOString(), jupiter: jupiterDetail, zenmoney: zenmoneyDetail };
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
